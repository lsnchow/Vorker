import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const optionalRuntimeBlocker = `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (["@agentclientprotocol/sdk", "next", "ws"].includes(specifier)) {
    throw new Error("Optional Node runtime loaded: " + specifier);
  }
  return nextResolve(specifier, context);
}
`)}`;

test("Rust TUI launcher script boots the one-shot chat shell", async () => {
  const scriptPath = path.join(process.cwd(), "scripts", "run-rust-tui.sh");
  const { stdout } = await execFileAsync("sh", [scriptPath, "--once"], {
    cwd: process.cwd(),
  });

  assert.match(stdout, />_ Vorker \(v0\.1\.0\)/);
  assert.match(stdout, /model:\s+claude-opus-4\.5\s+\/model to change/);
  assert.match(stdout, /directory:/);
  assert.match(stdout, /› Improve documentation in @filename/);
  assert.doesNotMatch(stdout, /Navigation|Conversation|Composer|Runs|Tasks/);
});

test("node bin wrapper routes bare vorker to the Rust shell", async () => {
  const { stdout } = await execFileAsync(
    "node",
    ["--no-warnings", "--experimental-loader", optionalRuntimeBlocker, "src/index.js", "--once"],
    {
      cwd: process.cwd(),
    },
  );

  assert.match(stdout, />_ Vorker \(v0\.1\.0\)/);
  assert.match(stdout, /claude-opus-4\.5/);
  assert.match(stdout, /› Improve documentation in @filename/);
});

test("node bin wrapper can render the hyperloop demo screen", async () => {
  const { stdout } = await execFileAsync("node", ["src/index.js", "demo", "hyperloop"], {
    cwd: process.cwd(),
  });

  assert.match(stdout, /Hyperloop Pod Controls/);
  assert.match(stdout, /Subagents/);
  assert.match(stdout, /Safety envelope verified/);
});

test("node bin wrapper forwards adversarial help to the Rust CLI", async () => {
  const { stdout } = await execFileAsync("node", ["src/index.js", "adversarial", "--help"], {
    cwd: process.cwd(),
  });

  assert.match(stdout, /Usage: vorker adversarial \[OPTIONS\] \[FOCUS\]\.\.\./);
  assert.match(stdout, /--coach/);
  assert.match(stdout, /--apply/);
  assert.match(stdout, /--popout/);
});

test("node bin wrapper forwards ralph dry-run to the Rust CLI", async () => {
  const { stdout } = await execFileAsync(
    "node",
    [
      "src/index.js",
      "ralph",
      "--dry-run",
      "--no-deslop",
      "--xhigh",
      "--model",
      "gpt-5.4",
      "ship",
      "it",
    ],
    {
      cwd: process.cwd(),
    },
  );

  assert.match(stdout, /CODEX_HOME=/);
  assert.match(stdout, /TERM=xterm-256color/);
  assert.match(stdout, /omx ralph --no-deslop --no-alt-screen --xhigh --model gpt-5\.4 ship it/);
});

test("node bin wrapper accepts provider and codex-bin options for Rust commands", async () => {
  const { stdout } = await execFileAsync(
    "node",
    ["src/index.js", "tui", "--once", "--provider", "codex", "--codex-bin", "/tmp/codex"],
    {
      cwd: process.cwd(),
    },
  );

  assert.match(stdout, />_ Vorker \(v0\.1\.0\)/);
});

test("node bin wrapper prints tailscale dry-run command", async () => {
  const { stdout } = await execFileAsync(
    "node",
    [
      "src/index.js",
      "tailnet",
      "--dry-run",
      "--port",
      "4555",
      "--tailscale-bin",
      "/tmp/tailscale",
      "--tailscale-socket",
      "/tmp/tailscaled.sock",
    ],
    {
      cwd: process.cwd(),
    },
  );

  assert.match(stdout, /Local URL: http:\/\/127\.0\.0\.1:4555/);
  assert.match(
    stdout,
    /\/tmp\/tailscale --socket \/tmp\/tailscaled\.sock serve --bg --yes http:\/\/127\.0\.0\.1:4555/,
  );
});
