#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

function printUsage() {
  console.log(`vorker

Usage:
  vorker
  vorker tui [options]
  vorker adversarial [options] [focus...]
  vorker ralph [options] <task...>
  vorker demo <scenario>
  vorker repl [options]
  vorker chat [options] "<prompt>"
  vorker serve [options]
  vorker share [options]
  vorker tailnet [options]
  vorker help

Shared options:
  --cwd <path>           Working directory for Copilot sessions
  --provider <id>        Provider id for Rust command paths
  --copilot-bin <path>   Copilot CLI binary to launch (default: copilot)
  --codex-bin <path>     Codex CLI binary to launch (default: codex)
  --mode <id>            Set an ACP session mode after startup
  --model <id>           Set an ACP model after startup
  --base <ref>           Compare the current branch to a base ref for adversarial review
  --scope <name>         Review scope: auto, working-tree, staged, all-files, or branch
  --coach                Add teaching guidance to adversarial review output
  --apply                After adversarial review, ask Codex to apply the smallest safe patch
  --popout               Open a separate adversarial-themed Vorker shell
  --once                 Render a one-shot frame instead of opening the interactive shell
  --auto-approve         Auto-select the most permissive tool approval option
  --debug                Print extra ACP status updates
  --no-alt-screen        Keep the TUI inline instead of switching to the terminal alt screen
  --alt-screen           Opt into terminal alt screen mode for Rust TUI commands

RALPH options:
  --no-deslop            Skip RALPH final ai-slop-cleaner pass
  --xhigh                Launch RALPH with extra-high reasoning
  --dry-run              Print the RALPH launch command without executing it

Server options:
  --host <host>          Bind address for the web server (default: 127.0.0.1)
  --port <port>          Port for the web server (default: 4173)
  --tls-key <path>       TLS private key for HTTPS/WSS
  --tls-cert <path>      TLS certificate for HTTPS/WSS
  --trust-proxy          Trust forwarded proto headers from a reverse proxy/tunnel
  --allow-insecure-http  Allow binding a public interface without TLS

Share options:
  --cloudflared-bin <path>  Cloudflared binary to launch (default: cloudflared)
  --cloudflared-protocol <name>  Cloudflared edge protocol for share (default: http2)
  --cloudflared-edge-ip-version <mode>  Cloudflared edge IP mode for share (default: auto)

Tailscale options:
  --tailscale-bin <path>     Tailscale CLI binary to launch (default: tailscale)
  --tailscale-socket <path>  tailscaled socket path for userspace daemons
  --funnel                   Use public Tailscale Funnel instead of tailnet-only Serve

Security:
  Use VORKER_PASSWORD to set the phone/webapp login password.
  If omitted, a random pairing password is generated at startup.

Examples:
  vorker
  vorker tui
  vorker adversarial --coach --apply question the retry logic and patch the worst issue
  vorker demo hyperloop
  vorker repl
  vorker chat "summarize this repo"
  VORKER_PASSWORD=secret vorker serve --host 127.0.0.1 --port 4173
  VORKER_PASSWORD=secret vorker share
  VORKER_PASSWORD=secret vorker tailnet
  VORKER_PASSWORD=secret vorker serve --host 0.0.0.0 --tls-key certs/dev-key.pem --tls-cert certs/dev-cert.pem
`);
}

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      provider: { type: "string" },
      "copilot-bin": { type: "string" },
      "codex-bin": { type: "string" },
      mode: { type: "string" },
      model: { type: "string" },
      base: { type: "string" },
      scope: { type: "string" },
      coach: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      popout: { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      "auto-approve": { type: "boolean", default: false },
      debug: { type: "boolean", default: false },
      "no-alt-screen": { type: "boolean", default: false },
      host: { type: "string" },
      port: { type: "string" },
      "tls-key": { type: "string" },
      "tls-cert": { type: "string" },
      "trust-proxy": { type: "boolean", default: false },
      "allow-insecure-http": { type: "boolean", default: false },
      "cloudflared-bin": { type: "string" },
      "cloudflared-protocol": { type: "string" },
      "cloudflared-edge-ip-version": { type: "string" },
      "tailscale-bin": { type: "string" },
      "tailscale-socket": { type: "string" },
      funnel: { type: "boolean", default: false },
      "alt-screen": { type: "boolean", default: false },
      "no-deslop": { type: "boolean", default: false },
      xhigh: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command = "tui", ...promptParts] = positionals;

  return {
    command,
    promptParts,
    cwd: path.resolve(values.cwd ?? process.cwd()),
    provider: values.provider ?? null,
    copilotBin: values["copilot-bin"] ?? process.env.COPILOT_BIN ?? "copilot",
    codexBin: values["codex-bin"] ?? process.env.CODEX_BIN ?? "codex",
    mode: values.mode ?? null,
    model: values.model ?? process.env.VORKER_DEFAULT_MODEL ?? "claude-opus-4.5",
    base: values.base ?? null,
    scope: values.scope ?? null,
    coach: values.coach,
    apply: values.apply,
    popout: values.popout,
    once: values.once,
    autoApprove: values["auto-approve"],
    debug: values.debug,
    noAltScreen: values["no-alt-screen"],
    altScreen: values["alt-screen"],
    noDeslop: values["no-deslop"],
    xhigh: values.xhigh,
    dryRun: values["dry-run"],
    host: values.host ?? "127.0.0.1",
    port: values.port ?? "4173",
    tlsKey: values["tls-key"] ?? null,
    tlsCert: values["tls-cert"] ?? null,
    trustProxy: values["trust-proxy"],
    allowInsecureHttp: values["allow-insecure-http"],
    cloudflaredBin: values["cloudflared-bin"] ?? process.env.CLOUDFLARED_BIN ?? "cloudflared",
    cloudflaredProtocol: values["cloudflared-protocol"] ?? process.env.CLOUDFLARED_PROTOCOL ?? "http2",
    cloudflaredEdgeIpVersion:
      values["cloudflared-edge-ip-version"] ?? process.env.CLOUDFLARED_EDGE_IP_VERSION ?? "auto",
    tailscaleBin: values["tailscale-bin"] ?? process.env.TAILSCALE_BIN ?? "tailscale",
    tailscaleSocket: values["tailscale-socket"] ?? process.env.TAILSCALE_SOCKET ?? null,
    funnel: values.funnel,
    help: values.help,
  };
}

function formatError(error) {
  if (error && typeof error === "object") {
    const message = "message" in error ? String(error.message) : null;
    const code = "code" in error ? String(error.code) : null;
    if (code && message) {
      return `${message} (code: ${code})`;
    }
    if (message) {
      return message;
    }
  }

  return String(error);
}

function buildRustArgs(options) {
  const args = [];

  if (options.cwd) {
    args.push("--cwd", options.cwd);
  }
  if (options.provider) {
    args.push("--provider", options.provider);
  }
  if (options.copilotBin) {
    args.push("--copilot-bin", options.copilotBin);
  }
  if (options.codexBin) {
    args.push("--codex-bin", options.codexBin);
  }
  if (options.mode) {
    args.push("--mode", options.mode);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.autoApprove) {
    args.push("--auto-approve");
  }
  if (options.debug) {
    args.push("--debug");
  }
  if (options.noAltScreen) {
    args.push("--no-alt-screen");
  }
  if (options.altScreen) {
    args.push("--alt-screen");
  }

  if (options.command === "tui") {
    args.push("tui");
    if (options.once) {
      args.push("--once");
    }
    if (options.help) {
      args.push("--help");
    }
  } else if (options.command === "adversarial") {
    args.push("adversarial");
    if (options.base) {
      args.push("--base", options.base);
    }
    if (options.scope) {
      args.push("--scope", options.scope);
    }
    if (options.coach) {
      args.push("--coach");
    }
    if (options.apply) {
      args.push("--apply");
    }
    if (options.popout) {
      args.push("--popout");
    }
    args.push(...options.promptParts);
    if (options.help) {
      args.push("--help");
    }
  } else if (options.command === "ralph") {
    args.push("ralph");
    if (options.dryRun) {
      args.push("--dry-run");
    }
    if (options.noDeslop) {
      args.push("--no-deslop");
    }
    if (options.xhigh) {
      args.push("--xhigh");
    }
    if (options.model) {
      args.push("--model", options.model);
    }
    args.push(...options.promptParts);
    if (options.help) {
      args.push("--help");
    }
  } else if (options.command === "demo") {
    args.push("demo", ...options.promptParts);
    if (options.help) {
      args.push("--help");
    }
  }

  return args;
}

async function runRustCli(options) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const scriptPath = path.join(repoRoot, "scripts", "run-rust-cli.sh");
  const args = buildRustArgs(options);
  const captureOutput =
    options.command === "demo" || options.command === "adversarial" || options.once;

  await new Promise((resolve, reject) => {
    const child = spawn("sh", [scriptPath, ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: captureOutput ? ["inherit", "pipe", "pipe"] : "inherit",
    });

    if (captureOutput) {
      child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
      child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    }

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Rust CLI exited with signal ${signal}`));
        return;
      }
      if (code && code !== 0) {
        reject(new Error(`Rust CLI exited with status ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function main() {
  const options = parseCli(process.argv.slice(2));

  if (options.help || options.command === "help") {
    if (
      options.command === "tui" ||
      options.command === "demo" ||
      options.command === "adversarial" ||
      options.command === "ralph"
    ) {
      await runRustCli(options);
      return;
    }
    printUsage();
    return;
  }

  if (options.command === "chat") {
    const { runChat } = await import("./cli.js");
    await runChat(options);
    return;
  }

  if (
    options.command === "tui" ||
    options.command === "demo" ||
    options.command === "adversarial" ||
    options.command === "ralph"
  ) {
    await runRustCli(options);
    return;
  }

  if (options.command === "repl") {
    const { runRepl } = await import("./cli.js");
    await runRepl(options);
    return;
  }

  if (options.command === "serve") {
    const { startRemoteServer } = await import("./server.js");
    await startRemoteServer(options);
    return;
  }

  if (options.command === "share") {
    const { runShare } = await import("./share.js");
    await runShare(options);
    return;
  }

  if (options.command === "tailnet" || options.command === "tailscale") {
    const { runTailnet } = await import("./tailscale.js");
    await runTailnet(options);
    return;
  }

  throw new Error(`Unknown command: ${options.command}`);
}

main().catch((error) => {
  process.stderr.write(`${formatError(error)}\n`);
  if (String(error).includes("ENOENT")) {
    process.stderr.write(
      "Install GitHub Copilot CLI first, then rerun. You can also pass --copilot-bin to point at a custom binary.\n",
    );
  }
  process.exitCode = 1;
});
