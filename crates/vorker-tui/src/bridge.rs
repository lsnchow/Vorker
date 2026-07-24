use std::io;
use std::net::ToSocketAddrs;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use agent_client_protocol::{self as acp, Agent as _};
use base64::Engine as _;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

const COPILOT_CA_HOST: &str = "api.individual.githubcopilot.com";
const ACP_STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const BRIDGE_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const TLS_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TLS_IO_TIMEOUT: Duration = Duration::from_secs(5);
static COPILOT_EXTRA_CA_PATH: OnceLock<PathBuf> = OnceLock::new();

#[derive(Debug)]
enum BridgeCommand {
    Prompt { message: String },
    SetModel { model: String },
    Cancel,
    Shutdown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug)]
pub enum BridgeEvent {
    TextChunk {
        text: String,
    },
    ToolCall {
        title: String,
    },
    ToolUpdate {
        title: Option<String>,
        detail: Option<String>,
    },
    PermissionRequest {
        title: String,
        options: Vec<PermissionOption>,
        reply: oneshot::Sender<Option<String>>,
    },
    PromptDone,
    SessionReady {
        current_model: Option<String>,
        available_models: Vec<String>,
    },
    ModelChanged {
        model: String,
    },
    Error {
        message: String,
    },
}

pub struct AcpBridge {
    cmd_tx: mpsc::Sender<BridgeCommand>,
    pub evt_rx: mpsc::UnboundedReceiver<BridgeEvent>,
    handle: JoinHandle<io::Result<()>>,
}

impl AcpBridge {
    pub async fn start(
        cwd: PathBuf,
        copilot_bin: Option<String>,
        initial_model: Option<String>,
    ) -> io::Result<Self> {
        let (cmd_tx, cmd_rx) = mpsc::channel(16);
        let (evt_tx, evt_rx) = mpsc::unbounded_channel();
        let program = copilot_bin.unwrap_or_else(|| "copilot".to_string());
        let extra_ca_path = ensure_copilot_extra_ca_file()?;

        let handle = tokio::task::spawn_blocking(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(io::Error::other)?;
            let local = tokio::task::LocalSet::new();
            let startup_evt_tx = evt_tx.clone();
            let result = local.block_on(
                &runtime,
                bridge_main(cmd_rx, evt_tx, program, cwd, extra_ca_path, initial_model),
            );
            if let Err(error) = &result {
                report_bridge_startup_error(&startup_evt_tx, error);
            }
            result
        });

        Ok(Self {
            cmd_tx,
            evt_rx,
            handle,
        })
    }

    pub async fn prompt(&self, message: String) -> io::Result<()> {
        self.cmd_tx
            .send(BridgeCommand::Prompt { message })
            .await
            .map_err(|_| io::Error::other("bridge command channel closed"))
    }

    pub async fn set_model(&self, model: String) -> io::Result<()> {
        self.cmd_tx
            .send(BridgeCommand::SetModel { model })
            .await
            .map_err(|_| io::Error::other("bridge command channel closed"))
    }

    pub async fn cancel(&self) -> io::Result<()> {
        self.cmd_tx
            .send(BridgeCommand::Cancel)
            .await
            .map_err(|_| io::Error::other("bridge command channel closed"))
    }

    pub async fn shutdown(self) -> io::Result<()> {
        let _ = self.cmd_tx.send(BridgeCommand::Shutdown).await;
        match tokio::time::timeout(BRIDGE_SHUTDOWN_TIMEOUT, self.handle).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => Err(io::Error::other(format!("bridge join failed: {error}"))),
            Err(_) => Err(timeout_error("bridge shutdown", BRIDGE_SHUTDOWN_TIMEOUT)),
        }
    }
}

fn report_bridge_startup_error(evt_tx: &mpsc::UnboundedSender<BridgeEvent>, error: &io::Error) {
    let _ = evt_tx.send(BridgeEvent::Error {
        message: error.to_string(),
    });
}

async fn bridge_main(
    mut cmd_rx: mpsc::Receiver<BridgeCommand>,
    evt_tx: mpsc::UnboundedSender<BridgeEvent>,
    program: String,
    cwd: PathBuf,
    extra_ca_path: PathBuf,
    initial_model: Option<String>,
) -> io::Result<()> {
    let args = vec!["--acp".to_string()];

    let mut child = tokio::process::Command::new(&program)
        .args(&args)
        .current_dir(&cwd)
        .env("NODE_EXTRA_CA_CERTS", &extra_ca_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| io::Error::other(format!("{program}: {error}")))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("copilot ACP stdin unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("copilot ACP stdout unavailable"))?;

    let client = BridgedAcpClient {
        evt_tx: evt_tx.clone(),
    };
    let (conn, handle_io) =
        acp::ClientSideConnection::new(client, stdin.compat_write(), stdout.compat(), |future| {
            tokio::task::spawn_local(future);
        });
    let conn = Rc::new(conn);

    tokio::task::spawn_local(async move {
        if let Err(error) = handle_io.await {
            eprintln!("[vorker-tui] ACP transport error: {error}");
        }
    });

    run_with_timeout(
        "acp initialize",
        ACP_STARTUP_TIMEOUT,
        conn.initialize(
            acp::InitializeRequest::new(acp::ProtocolVersion::V1)
                .client_capabilities(
                    acp::ClientCapabilities::new()
                        .fs(acp::FileSystemCapabilities::new()
                            .read_text_file(true)
                            .write_text_file(true))
                        .terminal(true),
                )
                .client_info(acp::Implementation::new(
                    "vorker",
                    env!("CARGO_PKG_VERSION"),
                )),
        ),
    )
    .await?
    .map_err(|error| io::Error::other(format!("acp initialize failed: {error}")))?;

    let session = run_with_timeout(
        "acp new_session",
        ACP_STARTUP_TIMEOUT,
        conn.new_session(acp::NewSessionRequest::new(cwd)),
    )
    .await?
    .map_err(|error| io::Error::other(format!("acp new_session failed: {error}")))?;
    let session_id = session.session_id;
    let mut current_model = session
        .models
        .as_ref()
        .map(|models| models.current_model_id.to_string());
    let available_models: Vec<String> = session
        .models
        .as_ref()
        .map(|models| {
            models
                .available_models
                .iter()
                .map(|model| model.model_id.to_string())
                .collect()
        })
        .unwrap_or_default();

    if let Some(model) = initial_model
        && current_model.as_deref() != Some(model.as_str())
        && available_models.iter().any(|available| available == &model)
    {
        run_with_timeout(
            "acp set_session_model",
            ACP_STARTUP_TIMEOUT,
            conn.set_session_model(acp::SetSessionModelRequest::new(
                session_id.clone(),
                model.clone(),
            )),
        )
        .await?
        .map_err(|error| io::Error::other(format!("acp set_session_model failed: {error}")))?;
        current_model = Some(model);
    }

    let _ = evt_tx.send(BridgeEvent::SessionReady {
        current_model,
        available_models,
    });

    while let Some(command) = cmd_rx.recv().await {
        match command {
            BridgeCommand::Prompt { message } => {
                let conn = Rc::clone(&conn);
                let evt_tx = evt_tx.clone();
                let session_id = session_id.clone();
                tokio::task::spawn_local(async move {
                    let result = conn
                        .prompt(acp::PromptRequest::new(session_id, vec![message.into()]))
                        .await;
                    match result {
                        Ok(_) => {
                            let _ = evt_tx.send(BridgeEvent::PromptDone);
                        }
                        Err(error) => {
                            let _ = evt_tx.send(BridgeEvent::Error {
                                message: error.to_string(),
                            });
                            let _ = evt_tx.send(BridgeEvent::PromptDone);
                        }
                    }
                });
            }
            BridgeCommand::SetModel { model } => {
                let request = acp::SetSessionModelRequest::new(session_id.clone(), model.clone());
                match conn.set_session_model(request).await {
                    Ok(_) => {
                        let _ = evt_tx.send(BridgeEvent::ModelChanged { model });
                    }
                    Err(error) => {
                        let _ = evt_tx.send(BridgeEvent::Error {
                            message: error.to_string(),
                        });
                    }
                }
            }
            BridgeCommand::Cancel => {
                if let Err(error) = conn
                    .cancel(acp::CancelNotification::new(session_id.clone()))
                    .await
                {
                    let _ = evt_tx.send(BridgeEvent::Error {
                        message: format!("cancel failed: {error}"),
                    });
                }
            }
            BridgeCommand::Shutdown => break,
        }
    }

    child.kill().await.ok();
    Ok(())
}

async fn run_with_timeout<T>(
    operation: &'static str,
    timeout: Duration,
    future: impl std::future::Future<Output = T>,
) -> io::Result<T> {
    tokio::time::timeout(timeout, future)
        .await
        .map_err(|_| timeout_error(operation, timeout))
}

fn timeout_error(operation: &str, timeout: Duration) -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        format!("{operation} timed out after {}s", timeout.as_secs()),
    )
}

fn ensure_copilot_extra_ca_file() -> io::Result<PathBuf> {
    if let Ok(path) = std::env::var("NODE_EXTRA_CA_CERTS")
        && !path.trim().is_empty()
    {
        return Ok(PathBuf::from(path));
    }

    if let Some(path) = COPILOT_EXTRA_CA_PATH.get() {
        return Ok(path.clone());
    }

    let pem = fetch_copilot_cert_chain_pem()?;
    let output_path = std::env::temp_dir().join("vorker-copilot-extra-ca.pem");
    std::fs::write(&output_path, pem)?;
    let _ = COPILOT_EXTRA_CA_PATH.set(output_path.clone());
    Ok(output_path)
}

fn fetch_copilot_cert_chain_pem() -> io::Result<String> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let server_name = ServerName::try_from(COPILOT_CA_HOST.to_string())
        .map_err(|error| io::Error::other(format!("invalid server name: {error}")))?;
    let connection = ClientConnection::new(Arc::new(config), server_name)
        .map_err(|error| io::Error::other(format!("tls client init failed: {error}")))?;
    let address = resolve_copilot_socket_address()?;
    let socket = std::net::TcpStream::connect_timeout(&address, TLS_CONNECT_TIMEOUT)
        .map_err(|error| io::Error::other(format!("tls tcp connect failed: {error}")))?;
    socket
        .set_read_timeout(Some(TLS_IO_TIMEOUT))
        .map_err(|error| io::Error::other(format!("tls read timeout failed: {error}")))?;
    socket
        .set_write_timeout(Some(TLS_IO_TIMEOUT))
        .map_err(|error| io::Error::other(format!("tls write timeout failed: {error}")))?;
    let mut tls = StreamOwned::new(connection, socket);

    while tls.conn.is_handshaking() {
        tls.conn
            .complete_io(&mut tls.sock)
            .map_err(|error| io::Error::other(format!("tls handshake failed: {error}")))?;
    }

    let certs = tls
        .conn
        .peer_certificates()
        .ok_or_else(|| io::Error::other("tls peer did not provide certificates"))?;
    if certs.is_empty() {
        return Err(io::Error::other("tls peer certificate chain was empty"));
    }

    let mut pem = String::new();
    for cert in certs {
        pem.push_str(&pem_encode(cert.as_ref()));
    }
    Ok(pem)
}

fn resolve_copilot_socket_address() -> io::Result<std::net::SocketAddr> {
    (COPILOT_CA_HOST, 443)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::other("tls tcp connect resolved no addresses"))
}

fn pem_encode(bytes: &[u8]) -> String {
    let base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let mut pem = String::from("-----BEGIN CERTIFICATE-----\n");
    for chunk in base64.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        pem.push('\n');
    }
    pem.push_str("-----END CERTIFICATE-----\n");
    pem
}

struct BridgedAcpClient {
    evt_tx: mpsc::UnboundedSender<BridgeEvent>,
}

#[async_trait::async_trait(?Send)]
impl acp::Client for BridgedAcpClient {
    async fn request_permission(
        &self,
        args: acp::RequestPermissionRequest,
    ) -> acp::Result<acp::RequestPermissionResponse> {
        let title = args
            .tool_call
            .fields
            .title
            .clone()
            .unwrap_or_else(|| "Tool call".to_string());
        let options = args
            .options
            .iter()
            .map(|option| PermissionOption {
                option_id: option.option_id.0.to_string(),
                name: option.name.clone(),
                kind: match option.kind {
                    acp::PermissionOptionKind::AllowAlways => "allow_always",
                    acp::PermissionOptionKind::AllowOnce => "allow_once",
                    acp::PermissionOptionKind::RejectOnce => "reject_once",
                    acp::PermissionOptionKind::RejectAlways => "reject_always",
                    _ => "unknown",
                }
                .to_string(),
            })
            .collect();
        let (reply_tx, reply_rx) = oneshot::channel();
        let _ = self.evt_tx.send(BridgeEvent::PermissionRequest {
            title,
            options,
            reply: reply_tx,
        });

        let outcome = match reply_rx.await.ok().flatten() {
            Some(option_id) => acp::RequestPermissionOutcome::Selected(
                acp::SelectedPermissionOutcome::new(option_id),
            ),
            None => acp::RequestPermissionOutcome::Cancelled,
        };

        Ok(acp::RequestPermissionResponse::new(outcome))
    }

    async fn session_notification(&self, args: acp::SessionNotification) -> acp::Result<()> {
        match args.update {
            acp::SessionUpdate::AgentMessageChunk(chunk) => {
                if let acp::ContentBlock::Text(text) = chunk.content {
                    let _ = self.evt_tx.send(BridgeEvent::TextChunk { text: text.text });
                }
            }
            acp::SessionUpdate::ToolCall(tool_call) => {
                let _ = self.evt_tx.send(BridgeEvent::ToolCall {
                    title: tool_call.title,
                });
            }
            acp::SessionUpdate::ToolCallUpdate(update) => {
                let detail = update
                    .fields
                    .content
                    .as_ref()
                    .and_then(|entries| entries.first())
                    .and_then(|entry| match entry {
                        acp::ToolCallContent::Content(content) => match &content.content {
                            acp::ContentBlock::Text(text) => Some(text.text.clone()),
                            _ => None,
                        },
                        _ => None,
                    });
                let _ = self.evt_tx.send(BridgeEvent::ToolUpdate {
                    title: update.fields.title.clone(),
                    detail,
                });
            }
            _ => {}
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BRIDGE_SHUTDOWN_TIMEOUT, BridgeEvent, pem_encode, report_bridge_startup_error,
        resolve_copilot_socket_address, run_with_timeout, timeout_error,
    };
    use std::io;
    use std::time::Duration;
    use tokio::sync::mpsc;

    #[test]
    fn pem_encode_wraps_der_bytes_as_certificate_pem() {
        assert_eq!(
            pem_encode(&[0, 1, 2]),
            "-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\n"
        );
    }

    #[test]
    fn startup_errors_are_forwarded_as_bridge_events() {
        let (evt_tx, mut evt_rx) = mpsc::unbounded_channel();
        report_bridge_startup_error(&evt_tx, &io::Error::other("copilot failed"));

        match evt_rx.try_recv() {
            Ok(BridgeEvent::Error { message }) => assert_eq!(message, "copilot failed"),
            other => panic!("expected startup error event, got {other:?}"),
        }
    }

    #[test]
    fn timeout_error_uses_timed_out_kind() {
        let error = timeout_error("bridge shutdown", BRIDGE_SHUTDOWN_TIMEOUT);
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(error.to_string().contains("bridge shutdown timed out"));
    }

    #[test]
    fn startup_timeout_helper_fails_slow_operations() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let error = runtime
            .block_on(run_with_timeout(
                "acp initialize",
                Duration::from_millis(5),
                async {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                },
            ))
            .expect_err("timeout error");

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(error.to_string().contains("acp initialize timed out"));
    }

    #[test]
    fn resolve_copilot_socket_address_returns_an_address() {
        let address = resolve_copilot_socket_address().expect("socket address");
        assert_eq!(address.port(), 443);
    }
}
