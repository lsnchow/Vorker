import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import net from "node:net";

async function createTempEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorker-readme-"));
  const home = path.join(root, "home");
  const vorkerHome = path.join(root, "vorker");
  const binDir = path.join(root, "bin");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(vorkerHome, { recursive: true }), mkdir(binDir, { recursive: true })]);
  return { root, home, vorkerHome, binDir };
}

async function writeExecutable(filePath, source) {
  await writeFile(filePath, source, { mode: 0o755 });
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a TCP port.")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function spawnCommand(args, { env = {} } = {}) {
  const child = spawn(process.execPath, ["src/index.js", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  return { child, exited, getStdout: () => stdout, getStderr: () => stderr };
}

async function waitForText(read, pattern, label, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = read();
    if (pattern.test(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}.\nCurrent output:\n${read()}`);
}

async function terminate(child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await exited;
    return;
  }

  child.kill("SIGTERM");
  const result = await exited;
  if (result.signal && result.signal !== "SIGTERM") {
    throw new Error(`Process exited with unexpected signal ${result.signal}.`);
  }
}

test("README serve command boots the local web UI and answers /api/me", async () => {
  const temp = await createTempEnv();
  const port = await getFreePort();
  const command = spawnCommand(["serve", "--host", "127.0.0.1", "--port", String(port)], {
    env: {
      HOME: temp.home,
      VORKER_HOME: temp.vorkerHome,
      VORKER_PASSWORD: "secret",
    },
  });

  try {
    await waitForText(command.getStderr, /Remote server listening on http:\/\/127\.0\.0\.1:/, "serve startup");

    const response = await fetch(`http://127.0.0.1:${port}/api/me`);
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.deepEqual(payload, {
      authenticated: false,
      secureTransport: false,
      transportMode: "local",
      cwd: process.cwd(),
      csrfToken: "",
    });
  } finally {
    await terminate(command.child, command.exited);
  }
});

test("README share command prints a public URL when cloudflared reports readiness", async () => {
  const temp = await createTempEnv();
  const port = await getFreePort();
  const cloudflaredPath = path.join(temp.binDir, "cloudflared");
  await writeExecutable(
    cloudflaredPath,
    `#!/bin/sh
printf 'https://demo.trycloudflare.com\\n' >&2
printf 'Registered tunnel connection\\n' >&2
exec sleep 30
`,
  );

  const command = spawnCommand(["share", "--port", String(port), "--cloudflared-bin", cloudflaredPath], {
    env: {
      HOME: temp.home,
      VORKER_HOME: temp.vorkerHome,
      VORKER_PASSWORD: "secret",
    },
  });

  try {
    const stdout = await waitForText(command.getStdout, /Share URL:/, "share readiness");
    assert.match(stdout, /Share URL: https:\/\/demo\.trycloudflare\.com\?transport=poll/);
    assert.match(stdout, /Password: secret/);
    assert.match(stdout, /Transport: HTTPS edge \+ Cloudflare http2\/auto/);
  } finally {
    await terminate(command.child, command.exited);
  }
});

test("README tailnet command prints the tailnet URL when tailscale serve succeeds", async () => {
  const temp = await createTempEnv();
  const port = await getFreePort();
  const tailscalePath = path.join(temp.binDir, "tailscale");
  await writeExecutable(
    tailscalePath,
    `#!/bin/sh
if [ "$1" = "status" ] || [ "$2" = "status" ]; then
  printf '{"Self":{"DNSName":"demo.ts.net."}}\\n'
  exit 0
fi
exit 0
`,
  );

  const command = spawnCommand(["tailnet", "--port", String(port), "--tailscale-bin", tailscalePath], {
    env: {
      HOME: temp.home,
      VORKER_HOME: temp.vorkerHome,
      VORKER_PASSWORD: "secret",
    },
  });

  try {
    const stdout = await waitForText(command.getStdout, /Tailnet URL:/, "tailnet readiness");
    assert.match(stdout, /Tailnet URL: https:\/\/demo\.ts\.net/);
    assert.match(stdout, new RegExp(`Local URL: http://127\\.0\\.0\\.1:${port}`));
    assert.match(stdout, /Transport: Tailscale serve -> Vorker localhost server\./);
  } finally {
    await terminate(command.child, command.exited);
  }
});

test("README adversarial command renders a structured review when codex returns JSON", async () => {
  const temp = await createTempEnv();
  const codexPath = path.join(temp.binDir, "codex");
  await writeExecutable(
    codexPath,
    `#!/bin/sh
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    output="$2"
    shift 2
    continue
  fi
  shift
done
cat >/dev/null
json='{"verdict":"needs-attention","summary":"Mock summary","findings":[{"severity":"high","title":"Mock finding","body":"Mock body","file":"README.md","line_start":1,"line_end":1,"confidence":0.95,"recommendation":"Mock fix","teaching_note":"Mock note","patch_plan":"Mock plan"}],"next_steps":["Mock next"]}'
escaped=$(printf '%s' "$json" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "$escaped"
if [ -n "$output" ]; then
  printf '%s' "$json" > "$output"
fi
`,
  );

  const command = spawnCommand(["adversarial", "--coach", "review this"], {
    env: {
      HOME: temp.home,
      VORKER_HOME: temp.vorkerHome,
      PATH: `${temp.binDir}:/usr/bin:/bin`,
    },
  });

  const result = await command.exited;
  assert.equal(result.code, 0, command.getStderr());
  assert.equal(result.signal, null);
  assert.match(command.getStdout(), /# Adversarial Review/);
  assert.match(command.getStdout(), /\*\*Verdict:\*\* needs-attention/);
  assert.match(command.getStdout(), /## Coaching/);
  assert.match(command.getStdout(), /Report saved to /);
});
