import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

const DEFAULT_READY_TIMEOUT_MS = 1000 * 45;
const DEFAULT_STOP_TIMEOUT_MS = 1000 * 5;
const DEFAULT_LOG_LIMIT = 80;

function extractQuickTunnelUrl(line) {
  const match = line.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i);
  if (!match) return null;
  const url = match[0];
  if (/^https:\/\/api\./i.test(url)) return null;
  return url;
}

function isEdgeConnectivityError(lowerLine) {
  return (
    lowerLine.includes("quic") ||
    (lowerLine.includes("dial tcp") && lowerLine.includes(":7844")) ||
    lowerLine.includes("unable to establish connection with cloudflare edge") ||
    lowerLine.includes("serve tunnel error")
  );
}

function formatExit(code, signal) {
  if (signal) {
    return `signal ${signal}`;
  }
  return `exit code ${code ?? 0}`;
}

export class TunnelManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = Number.parseInt(String(options.port ?? "4173"), 10);
    this.protocol = options.protocol ?? "http";
    this.host = options.host ?? "127.0.0.1";
    this.cloudflaredBin = options.cloudflaredBin ?? process.env.CLOUDFLARED_BIN ?? "cloudflared";
    this.edgeProtocol = options.edgeProtocol ?? process.env.CLOUDFLARED_PROTOCOL ?? "http2";
    this.edgeIpVersion = options.edgeIpVersion ?? process.env.CLOUDFLARED_EDGE_IP_VERSION ?? "auto";
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT;
    this.child = null;
    this.stdoutRl = null;
    this.stderrRl = null;
    this.publicUrl = null;
    this.tunnelRegistered = false;
    this.state = "idle";
    this.error = null;
    this.logs = [];
  }

  setPort(port) {
    const parsed = Number.parseInt(String(port), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      this.port = parsed;
    }
  }

  snapshot() {
    return {
      state: this.state,
      publicUrl: this.publicUrl ? `${this.publicUrl}?transport=poll` : null,
      localUrl: `${this.protocol}://${this.host}:${this.port}`,
      cloudflaredBin: this.cloudflaredBin,
      edgeProtocol: this.edgeProtocol,
      edgeIpVersion: this.edgeIpVersion,
      tunnelRegistered: this.tunnelRegistered,
      error: this.error,
      logs: [...this.logs],
    };
  }

  publish(type, payload = {}) {
    const event = {
      type,
      share: this.snapshot(),
      ...payload,
    };
    this.emit("event", event);
    return event;
  }

  pushLog(line, level = "info") {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      level,
      line,
      timestamp: new Date().toISOString(),
    };
    this.logs.push(entry);
    if (this.logs.length > this.logLimit) {
      this.logs.splice(0, this.logs.length - this.logLimit);
    }
    this.publish("share_log", { entry });
  }

  async start(options = {}) {
    if (this.child) {
      return this.snapshot();
    }

    if (options.cloudflaredBin) {
      this.cloudflaredBin = options.cloudflaredBin;
    }
    if (options.edgeProtocol) {
      this.edgeProtocol = options.edgeProtocol;
    }
    if (options.edgeIpVersion) {
      this.edgeIpVersion = options.edgeIpVersion;
    }

    const localUrl = `${this.protocol}://${this.host}:${this.port}`;
    const args = [
      "tunnel",
      "--protocol",
      this.edgeProtocol,
      "--edge-ip-version",
      this.edgeIpVersion,
      "--url",
      localUrl,
      "--no-autoupdate",
    ];

    if (this.protocol === "https") {
      args.push("--no-tls-verify");
    }

    this.state = "starting";
    this.error = null;
    this.publicUrl = null;
    this.tunnelRegistered = false;
    this.publish("share_state");
    this.pushLog(`Starting Cloudflare Quick Tunnel for ${localUrl}`);

    const child = spawn(this.cloudflaredBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const startError = await new Promise((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", (error) => resolve(error));
    });

    if (startError) {
      this.state = "error";
      this.error =
        startError && typeof startError === "object" && "code" in startError && startError.code === "ENOENT"
          ? `Could not find ${this.cloudflaredBin}. Install cloudflared or pass --cloudflared-bin.`
          : String(startError.message ?? startError);
      this.publish("share_state");
      throw new Error(this.error);
    }

    this.child = child;
    this.stdoutRl = readline.createInterface({ input: child.stdout });
    this.stderrRl = readline.createInterface({ input: child.stderr });

    const announceLine = (line) => {
      if (!line) {
        return;
      }

      const lower = line.toLowerCase();
      const level = lower.includes("error") || lower.includes("failed") ? "error" : "info";
      this.pushLog(line, level);

      const quickTunnelUrl = extractQuickTunnelUrl(line);
      if (quickTunnelUrl && !this.publicUrl) {
        this.publicUrl = quickTunnelUrl;
        this.publish("share_state");
      }

      if (lower.includes("registered tunnel connection")) {
        this.tunnelRegistered = true;
        this.publish("share_state");
      }

      if (isEdgeConnectivityError(lower)) {
        this.error = line;
        this.publish("share_state");
      }
    };

    this.stdoutRl.on("line", announceLine);
    this.stderrRl.on("line", announceLine);

    child.once("exit", (code, signal) => {
      const priorState = this.state;
      this.child = null;
      this.stdoutRl?.close();
      this.stderrRl?.close();
      this.stdoutRl = null;
      this.stderrRl = null;
      this.state = "idle";
      if (priorState !== "stopping" && priorState !== "stopped" && priorState !== "idle") {
        this.error = `cloudflared exited (${formatExit(code, signal)}).`;
        this.pushLog(this.error, "error");
      }
      this.publish("share_state");
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for Cloudflare to assign and register the Quick Tunnel."));
      }, this.readyTimeoutMs);

      const interval = setInterval(() => {
        if (this.publicUrl && this.tunnelRegistered) {
          clearTimeout(timer);
          clearInterval(interval);
          resolve();
        }
      }, 100);

      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        clearInterval(interval);
        reject(new Error(`cloudflared exited before the tunnel was ready (${formatExit(code, signal)}).`));
      });
    }).catch((error) => {
      this.state = "error";
      this.error = error.message;
      this.publish("share_state");
      void this.stop();
      throw error;
    });

    this.state = "ready";
    this.error = null;
    this.publish("share_state");
    return this.snapshot();
  }

  async stop() {
    if (!this.child) {
      this.state = "idle";
      this.publish("share_state");
      return this.snapshot();
    }

    const child = this.child;
    this.state = "stopping";
    this.publish("share_state");

    await new Promise((resolve) => {
      const forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, this.stopTimeoutMs);
      child.once("exit", () => {
        clearTimeout(forceKillTimer);
        resolve();
      });
      child.kill("SIGTERM");
    });

    this.state = "idle";
    this.error = null;
    this.publicUrl = null;
    this.tunnelRegistered = false;
    this.publish("share_state");
    return this.snapshot();
  }
}
