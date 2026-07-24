import { spawn } from "node:child_process";
import process from "node:process";
import readline from "node:readline";
import { startRemoteServer } from "./server.js";

const TUNNEL_READY_TIMEOUT_MS = 45000;

function extractQuickTunnelUrl(line) {
  const match = line.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i);
  return match ? match[0] : null;
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

export async function runShare(options) {
  const localServer = await startRemoteServer({
    ...options,
    host: "127.0.0.1",
    trustProxy: true,
    installSignalHandlers: false,
    tlsKey: null,
    tlsCert: null,
  });

  const localUrl = `http://127.0.0.1:${localServer.normalized.port}`;
  const password = localServer.pairingPassword;
  const cloudflaredBin = options.cloudflaredBin ?? process.env.CLOUDFLARED_BIN ?? "cloudflared";
  const cloudflaredProtocol = options.cloudflaredProtocol ?? process.env.CLOUDFLARED_PROTOCOL ?? "http2";
  const cloudflaredEdgeIpVersion = options.cloudflaredEdgeIpVersion ?? process.env.CLOUDFLARED_EDGE_IP_VERSION ?? "auto";

  process.stderr.write(`Local share server listening on ${localUrl}\n`);
  process.stderr.write("Starting Cloudflare Quick Tunnel...\n");

  const child = spawn(
    cloudflaredBin,
    [
      "tunnel",
      "--protocol",
      cloudflaredProtocol,
      "--edge-ip-version",
      cloudflaredEdgeIpVersion,
      "--url",
      localUrl,
      "--no-autoupdate",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let shuttingDown = false;
  let publicUrl = null;
  let tunnelRegistered = false;
  let announcedReady = false;
  let edgeConnectivityErrorCount = 0;
  let lastEdgeConnectivityError = null;
  let signalHandlersInstalled = false;

  const handleSigint = () => {
    void shutdownAndExit();
  };
  const handleSigterm = () => {
    void shutdownAndExit();
  };

  const removeSignalHandlers = () => {
    if (!signalHandlersInstalled) {
      return;
    }
    signalHandlersInstalled = false;
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);
  };

  const maybeAnnounceReady = () => {
    if (!publicUrl || !tunnelRegistered || announcedReady) {
      return;
    }

    announcedReady = true;
    process.stdout.write(`Share URL: ${publicUrl}\n`);
    process.stdout.write(`Password: ${password}\n`);
    process.stdout.write(
      `Transport: HTTPS edge + Cloudflare ${cloudflaredProtocol}/${cloudflaredEdgeIpVersion} + long-polling to your local machine through Cloudflare Tunnel.\n`,
    );
  };

  const cleanup = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    removeSignalHandlers();

    if (!child.killed) {
      child.kill("SIGTERM");
    }

    await localServer.shutdown();
  };

  const announceLine = (line) => {
    if (!line) {
      return;
    }

    const quickTunnelUrl = extractQuickTunnelUrl(line);
    if (quickTunnelUrl && !publicUrl) {
      publicUrl = `${quickTunnelUrl}?transport=poll`;
      if (!tunnelRegistered) {
        process.stderr.write("Cloudflare assigned a public URL. Waiting for the tunnel connection to register...\n");
      }
      maybeAnnounceReady();
    }

    const lower = line.toLowerCase();
    if (lower.includes("registered tunnel connection")) {
      tunnelRegistered = true;
      if (!publicUrl) {
        process.stderr.write("Cloudflare registered the tunnel connection. Waiting for the public URL...\n");
      }
      maybeAnnounceReady();
    }

    if (isEdgeConnectivityError(lower)) {
      edgeConnectivityErrorCount += 1;
      lastEdgeConnectivityError = line;
    }

    if (lower.includes("error") || lower.includes("failed")) {
      process.stderr.write(`[cloudflared] ${line}\n`);
    }
  };

  const wireStream = (stream) => {
    const rl = readline.createInterface({ input: stream });
    rl.on("line", announceLine);
    return rl;
  };

  const stdoutRl = wireStream(child.stdout);
  const stderrRl = wireStream(child.stderr);

  const childReady = await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  }).catch(async (error) => {
    stdoutRl.close();
    stderrRl.close();
    await cleanup();
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Could not find ${cloudflaredBin}. Install cloudflared or pass --cloudflared-bin.`);
    }
    throw error;
  });

  void childReady;

  const tunnelReady = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for Cloudflare to assign and register the Quick Tunnel."));
    }, TUNNEL_READY_TIMEOUT_MS);

    const finish = (result, isError = false) => {
      clearTimeout(timer);
      if (isError) {
        reject(result);
      } else {
        resolve(result);
      }
    };

    child.once("exit", (code, signal) => {
      finish(new Error(`cloudflared exited before the tunnel was ready (${formatExit(code, signal)}).`), true);
    });

    const interval = setInterval(() => {
      if (publicUrl && tunnelRegistered) {
        clearInterval(interval);
        finish(publicUrl);
      }
    }, 100);
  }).catch(async (error) => {
    stdoutRl.close();
    stderrRl.close();
    if (edgeConnectivityErrorCount > 0) {
      process.stderr.write(
        "[cloudflared] Cloudflare edge connectivity never stabilized. Check WARP/VPN/firewall settings, or retry with --cloudflared-edge-ip-version 4.\n",
      );
      if (lastEdgeConnectivityError) {
        process.stderr.write(`[cloudflared] Last edge error: ${lastEdgeConnectivityError}\n`);
      }
    }
    await cleanup();
    throw error;
  });

  maybeAnnounceReady();
  void tunnelReady;

  const exitPromise = new Promise((resolve) => {
    child.once("exit", async (code, signal) => {
      const alreadyShuttingDown = shuttingDown;
      stdoutRl.close();
      stderrRl.close();
      await cleanup();
      if (!alreadyShuttingDown) {
        process.stderr.write(`Cloudflare Tunnel closed (${formatExit(code, signal)}).\n`);
      }
      resolve();
    });
  });

  const shutdownAndExit = async () => {
    await cleanup();
    stdoutRl.close();
    stderrRl.close();
    process.exit(0);
  };

  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);
  signalHandlersInstalled = true;

  await exitPromise;
}
