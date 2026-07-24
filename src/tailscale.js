import { spawn } from "node:child_process";
import process from "node:process";
import { startRemoteServer } from "./server.js";

function tailscalePrefix(options) {
  const bin = options.tailscaleBin ?? process.env.TAILSCALE_BIN ?? "tailscale";
  const args = [];
  const socket = options.tailscaleSocket ?? process.env.TAILSCALE_SOCKET ?? null;
  if (socket) {
    args.push("--socket", socket);
  }
  return { bin, args };
}

export function buildTailscaleServeCommand(options) {
  const { bin, args } = tailscalePrefix(options);
  const mode = options.funnel ? "funnel" : "serve";
  const target = options.target ?? `http://127.0.0.1:${options.port ?? 4173}`;
  return {
    bin,
    args: [...args, mode, "--bg", "--yes", target],
    target,
    mode,
  };
}

function runCommand(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal || code) {
        reject(new Error(`${bin} ${args.join(" ")} failed: ${stderr || stdout || signal || code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function tailscaleStatus(options) {
  const { bin, args } = tailscalePrefix(options);
  try {
    const result = await runCommand(bin, [...args, "status", "--json"], options);
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

export async function runTailnet(options) {
  const port = options.port ?? "4173";
  if (options.dryRun) {
    const serveCommand = buildTailscaleServeCommand({ ...options, port });
    process.stdout.write(`Local URL: http://127.0.0.1:${port}\n`);
    process.stdout.write(`${serveCommand.bin} ${serveCommand.args.join(" ")}\n`);
    return;
  }

  const localServer = await startRemoteServer({
    ...options,
    host: "127.0.0.1",
    port,
    trustProxy: true,
    installSignalHandlers: false,
    tlsKey: null,
    tlsCert: null,
  });

  const cleanup = async () => {
    removeSignalHandlers();
    await localServer.shutdown();
  };

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
  const serveCommand = buildTailscaleServeCommand({
    ...options,
    port: localServer.normalized.port,
  });

  try {
    await runCommand(serveCommand.bin, serveCommand.args, options);
  } catch (error) {
    await cleanup();
    throw error;
  }

  const status = await tailscaleStatus(options);
  const dnsName = status?.Self?.DNSName ? String(status.Self.DNSName).replace(/\.$/, "") : null;
  const url = dnsName ? `https://${dnsName}` : `tailscale ${serveCommand.mode} status`;

  process.stdout.write(`Tailnet URL: ${url}\n`);
  process.stdout.write(`Password: ${localServer.pairingPassword}\n`);
  process.stdout.write(`Local URL: http://127.0.0.1:${localServer.normalized.port}\n`);
  process.stdout.write(`Transport: Tailscale ${serveCommand.mode} -> Vorker localhost server.\n`);

  const shutdownAndExit = async () => {
    await cleanup();
    process.exit(0);
  };

  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);
  signalHandlersInstalled = true;

  await new Promise(() => {});
}
