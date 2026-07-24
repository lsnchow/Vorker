import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import net from "node:net";

import { startRemoteServer } from "../src/server.js";
import { TunnelManager } from "../src/tunnel.js";

async function createTempEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorker-server-regression-"));
  const home = path.join(root, "home");
  const vorkerHome = path.join(root, "vorker");
  const binDir = path.join(root, "bin");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(vorkerHome, { recursive: true }),
    mkdir(binDir, { recursive: true }),
  ]);
  return { root, home, vorkerHome, binDir };
}

async function writeExecutable(filePath, source) {
  await writeFile(filePath, source, { mode: 0o755 });
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
  await exited;
}

async function waitFor(check, label, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function loginSession(localServer) {
  const address = localServer.server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
    },
    body: JSON.stringify({ password: localServer.pairingPassword }),
  });

  const rawBody = await response.text();
  assert.equal(response.status, 200, rawBody);
  const payload = JSON.parse(rawBody);
  const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const cookieHeader = setCookies[0] ?? response.headers.get("set-cookie");
  assert.ok(cookieHeader, "expected session cookie");

  return {
    baseUrl,
    cookie: cookieHeader.split(";", 1)[0],
    csrfToken: payload.csrfToken,
  };
}

async function postCommand(session, payload) {
  const response = await fetch(`${session.baseUrl}/api/command`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: session.baseUrl,
      cookie: session.cookie,
      "x-vorker-csrf": session.csrfToken,
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.response;
}

async function runMalformedCookieProbe({ upgrade = false } = {}) {
  const script = `
    import net from "node:net";
    import { startRemoteServer } from "./src/server.js";

    const local = await startRemoteServer({
      host: "127.0.0.1",
      port: 0,
      installSignalHandlers: false,
      trustProxy: true,
      tlsKey: null,
      tlsCert: null,
    });
    const port = local.server.address().port;
    const request = ${JSON.stringify(
      upgrade
        ? "GET /ws?csrf=test HTTP/1.1\r\nHost: __HOST__\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://__HOST__\r\nCookie: vorker_session=%E0%A4%A\r\n\r\n"
        : "GET /api/me HTTP/1.1\r\nHost: __HOST__\r\nCookie: vorker_session=%E0%A4%A\r\nConnection: close\r\n\r\n",
    )}.replaceAll("__HOST__", \`127.0.0.1:\${port}\`);

    const result = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(request);
      });
      let data = "";
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve({ timeout: true, data });
      });
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
      });
      socket.on("end", () => {
        resolve({ ended: true, data });
      });
      socket.on("error", (error) => {
        resolve({ error: String(error), data });
      });
    });

    console.log(JSON.stringify({ result, stillListening: local.server.listening }));
    await local.shutdown();
  `;

  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
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

  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const lines = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const payload = JSON.parse(lines.at(-1));
  return { exit, stdout, stderr, payload };
}

test("HTTP malformed percent-encoded cookies receive a controlled response without server exceptions", async () => {
  const probe = await runMalformedCookieProbe();

  assert.equal(probe.exit.code, 0, probe.stderr);
  assert.equal(probe.payload.stillListening, true);
  assert.match(probe.payload.result.data, /^HTTP\/1\.1 \d{3} /);
  assert.doesNotMatch(probe.stderr, /URIError|unhandledRejection|uncaughtException/);
});

test("WebSocket upgrade malformed percent-encoded cookies receive a controlled HTTP rejection", async () => {
  const probe = await runMalformedCookieProbe({ upgrade: true });

  assert.equal(probe.exit.code, 0, probe.stderr);
  assert.equal(probe.payload.stillListening, true);
  assert.match(probe.payload.result.data, /^HTTP\/1\.1 \d{3} /);
  assert.doesNotMatch(probe.stderr, /URIError|unhandledRejection|uncaughtException/);
});

test("startRemoteServer reports the actual bound port when started with port 0", async () => {
  const localServer = await startRemoteServer({
    host: "127.0.0.1",
    port: 0,
    installSignalHandlers: false,
    trustProxy: true,
    tlsKey: null,
    tlsCert: null,
  });

  try {
    const address = localServer.server.address();
    assert.ok(address && typeof address !== "string");
    assert.ok(address.port > 0);
    assert.equal(localServer.normalized.port, address.port);
  } finally {
    await localServer.shutdown();
  }
});

test("share command uses the effective ephemeral port for its local URL and cloudflared target", async () => {
  const temp = await createTempEnv();
  const cloudflaredPath = path.join(temp.binDir, "cloudflared");
  const argsPath = path.join(temp.root, "cloudflared-args.txt");
  await writeExecutable(
    cloudflaredPath,
    `#!/bin/sh
printf '%s\n' "$@" > "${argsPath}"
printf 'https://demo.trycloudflare.com\n' >&2
printf 'Registered tunnel connection\n' >&2
exec sleep 30
`,
  );

  const command = spawnCommand(["share", "--port", "0", "--cloudflared-bin", cloudflaredPath], {
    env: {
      HOME: temp.home,
      VORKER_HOME: temp.vorkerHome,
      VORKER_PASSWORD: "secret",
    },
  });

  try {
    await waitForText(command.getStdout, /Share URL:/, "share readiness");
    const stderr = command.getStderr();
    const args = await readFile(argsPath, "utf8");
    const localUrlMatch = stderr.match(/Local share server listening on (http:\/\/127\.0\.0\.1:(\d+))/);

    assert.ok(localUrlMatch, stderr);
    assert.notEqual(localUrlMatch[2], "0", stderr);
    assert.match(args, new RegExp(`^--url\\n${localUrlMatch[1]}$`, "m"));
  } finally {
    await terminate(command.child, command.exited);
  }
});

test("tailnet command uses the effective ephemeral port for its local URL and tailscale target", async () => {
  const temp = await createTempEnv();
  const tailscalePath = path.join(temp.binDir, "tailscale");
  const argsPath = path.join(temp.root, "tailscale-args.txt");
  await writeExecutable(
    tailscalePath,
    `#!/bin/sh
if [ "$1" = "status" ] || [ "$2" = "status" ]; then
  printf '{"Self":{"DNSName":"demo.ts.net."}}\n'
else
  printf '%s\n' "$@" > "${argsPath}"
fi
exit 0
`,
  );

  const command = spawnCommand(["tailnet", "--port", "0", "--tailscale-bin", tailscalePath], {
    env: {
      HOME: temp.home,
      VORKER_HOME: temp.vorkerHome,
      VORKER_PASSWORD: "secret",
    },
  });

  try {
    const stdout = await waitForText(command.getStdout, /Tailnet URL:/, "tailnet readiness");
    const localUrlMatch = stdout.match(/Local URL: (http:\/\/127\.0\.0\.1:(\d+))/);
    const args = await readFile(argsPath, "utf8");

    assert.ok(localUrlMatch, stdout);
    assert.notEqual(localUrlMatch[2], "0", stdout);
    assert.match(args, new RegExp(`^http://127\\.0\\.0\\.1:${localUrlMatch[2]}$`, "m"));
  } finally {
    await terminate(command.child, command.exited);
  }
});

test("trust-proxy mode blocks client-controlled autoApprove unless explicitly allowed", async () => {
  const previous = process.env.VORKER_ALLOW_REMOTE_AUTO_APPROVE;
  delete process.env.VORKER_ALLOW_REMOTE_AUTO_APPROVE;

  const localServer = await startRemoteServer({
    host: "127.0.0.1",
    port: 0,
    installSignalHandlers: false,
    trustProxy: true,
    tlsKey: null,
    tlsCert: null,
  });

  try {
    const session = await loginSession(localServer);
    const created = await postCommand(session, {
      type: "create_agent",
      name: "remote-blocked",
      autoApprove: true,
    });

    assert.equal(created.agent.autoApprove, false);

    const updated = await postCommand(session, {
      type: "update_agent",
      agentId: created.agent.id,
      autoApprove: true,
    });

    assert.equal(updated.agent.autoApprove, false);
  } finally {
    if (previous === undefined) {
      delete process.env.VORKER_ALLOW_REMOTE_AUTO_APPROVE;
    } else {
      process.env.VORKER_ALLOW_REMOTE_AUTO_APPROVE = previous;
    }
    await localServer.shutdown();
  }
});

test("share_start clears existing autoApprove, blocks new remote autoApprove, and uses the effective bound port", async () => {
  const previous = process.env.VORKER_ALLOW_REMOTE_AUTO_APPROVE;
  delete process.env.VORKER_ALLOW_REMOTE_AUTO_APPROVE;

  const temp = await createTempEnv();
  const cloudflaredPath = path.join(temp.binDir, "cloudflared");
  const argsPath = path.join(temp.root, "cloudflared-args.txt");
  await writeExecutable(
    cloudflaredPath,
    `#!/bin/sh
printf '%s\n' "$@" > "${argsPath}"
printf 'https://demo.trycloudflare.com\n' >&2
printf 'Registered tunnel connection\n' >&2
exec sleep 30
`,
  );

  const localServer = await startRemoteServer({
    host: "127.0.0.1",
    port: 0,
    installSignalHandlers: false,
    trustProxy: false,
    tlsKey: null,
    tlsCert: null,
  });

  try {
    const session = await loginSession(localServer);
    const initiallyApproved = await postCommand(session, {
      type: "create_agent",
      name: "local-before-share",
      autoApprove: true,
    });

    assert.equal(initiallyApproved.agent.autoApprove, true);

    await postCommand(session, {
      type: "share_start",
      cloudflaredBin: cloudflaredPath,
    });

    const args = await waitFor(async () => {
      try {
        return await readFile(argsPath, "utf8");
      } catch {
        return null;
      }
    }, "cloudflared launch");
    const localUrlMatch = args.match(/^--url\n(http:\/\/127\.0\.0\.1:(\d+))$/m);

    assert.ok(localUrlMatch, args);
    assert.notEqual(localUrlMatch[2], "0");

    await waitFor(
      async () => {
        const agent = localServer.manager.listAgents().find((entry) => entry.id === initiallyApproved.agent.id);
        return agent?.autoApprove === false ? agent : null;
      },
      "share_start auto-approve reset",
    );

    const blocked = await postCommand(session, {
      type: "update_agent",
      agentId: initiallyApproved.agent.id,
      autoApprove: true,
    });

    assert.equal(blocked.agent.autoApprove, false);
  } finally {
    if (previous === undefined) {
      delete process.env.VORKER_ALLOW_REMOTE_AUTO_APPROVE;
    } else {
      process.env.VORKER_ALLOW_REMOTE_AUTO_APPROVE = previous;
    }
    await localServer.shutdown();
  }
});

test("VORKER_ALLOW_REMOTE_AUTO_APPROVE=1 permits client-controlled autoApprove in trust-proxy mode", async () => {
  const previous = process.env.VORKER_ALLOW_REMOTE_AUTO_APPROVE;
  process.env.VORKER_ALLOW_REMOTE_AUTO_APPROVE = "1";

  const localServer = await startRemoteServer({
    host: "127.0.0.1",
    port: 0,
    installSignalHandlers: false,
    trustProxy: true,
    tlsKey: null,
    tlsCert: null,
  });

  try {
    const session = await loginSession(localServer);
    const created = await postCommand(session, {
      type: "create_agent",
      name: "remote-opt-in",
      autoApprove: true,
    });

    assert.equal(created.agent.autoApprove, true);
  } finally {
    if (previous === undefined) {
      delete process.env.VORKER_ALLOW_REMOTE_AUTO_APPROVE;
    } else {
      process.env.VORKER_ALLOW_REMOTE_AUTO_APPROVE = previous;
    }
    await localServer.shutdown();
  }
});

test("startRemoteServer removes its SIGINT and SIGTERM handlers on shutdown", async () => {
  const sigintBefore = process.listenerCount("SIGINT");
  const sigtermBefore = process.listenerCount("SIGTERM");
  const localServer = await startRemoteServer({
    host: "127.0.0.1",
    port: 0,
    trustProxy: false,
    tlsKey: null,
    tlsCert: null,
  });

  try {
    assert.equal(process.listenerCount("SIGINT"), sigintBefore + 1);
    assert.equal(process.listenerCount("SIGTERM"), sigtermBefore + 1);
  } finally {
    await localServer.shutdown();
  }

  assert.equal(process.listenerCount("SIGINT"), sigintBefore);
  assert.equal(process.listenerCount("SIGTERM"), sigtermBefore);
});

test("TunnelManager force-stops a tunnel that ignores SIGTERM", async () => {
  const temp = await createTempEnv();
  const cloudflaredPath = path.join(temp.binDir, "cloudflared");
  await writeExecutable(
    cloudflaredPath,
    `#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stderr.write("https://demo.trycloudflare.com\\n");
process.stderr.write("Registered tunnel connection\\n");
setInterval(() => {}, 1000);
`,
  );

  const manager = new TunnelManager({
    cloudflaredBin: cloudflaredPath,
    readyTimeoutMs: 1000,
    stopTimeoutMs: 200,
  });

  await manager.start();
  const startedAt = Date.now();
  await manager.stop();

  assert.ok(Date.now() - startedAt < 1000, "tunnel stop should be bounded");
  assert.equal(manager.child, null);
  assert.equal(manager.state, "idle");
});
