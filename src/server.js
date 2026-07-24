import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import next from "next";
import path from "node:path";
import process from "node:process";
import { WebSocketServer } from "ws";
import { CopilotManager } from "./copilot.js";
import { Orchestrator } from "./orchestrator.js";
import { SkillCatalog } from "./skills.js";
import { EventLog as PersistentSupervisorEventLog } from "./supervisor/event-log.js";
import { restoreDurableSupervisorState } from "./supervisor/bootstrap.js";
import { SupervisorService } from "./supervisor/service.js";
import { TunnelManager } from "./tunnel.js";

const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 1000 * 25;
const MAX_EVENT_LOG_ENTRIES = 4000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 1000 * 60;
const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLocalBinding(host) {
  return LOCAL_HOSTS.has(host);
}

function parseBooleanHeader(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return null;
}

function parseForwardedProto(req) {
  const xForwardedProto = req.headers["x-forwarded-proto"];
  if (typeof xForwardedProto === "string" && xForwardedProto.trim()) {
    return xForwardedProto.split(",")[0].trim().toLowerCase();
  }

  const forwarded = req.headers.forwarded;
  if (typeof forwarded === "string") {
    const match = forwarded.match(/proto=([^;,\s]+)/i);
    if (match?.[1]) {
      return match[1].trim().toLowerCase();
    }
  }

  const cfVisitor = req.headers["cf-visitor"];
  if (typeof cfVisitor === "string") {
    try {
      const parsed = JSON.parse(cfVisitor);
      if (typeof parsed.scheme === "string") {
        return parsed.scheme.trim().toLowerCase();
      }
    } catch {
      // Ignore malformed proxy metadata.
    }
  }

  return null;
}

function parseCookies(cookieHeader = "") {
  const cookies = {};
  for (const entry of cookieHeader.split(";")) {
    const [rawKey, ...rest] = entry.trim().split("=");
    if (!rawKey) {
      continue;
    }
    const rawValue = rest.join("=");
    try {
      cookies[rawKey] = decodeURIComponent(rawValue);
    } catch {
      cookies[rawKey] = rawValue;
    }
  }
  return cookies;
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function requestIp(req) {
  return req.socket.remoteAddress ?? "unknown";
}

function hasJsonContentType(req) {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string") {
    return false;
  }
  return contentType.toLowerCase().includes("application/json");
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new Error("Request body too large.");
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function applySecurityHeaders(res, secureTransport) {
  const allowDevUnsafeEval = process.env.NODE_ENV !== "production";
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  if (allowDevUnsafeEval) {
    scriptSrc.push("'unsafe-eval'");
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()");
  res.setHeader("Origin-Agent-Cluster", "?1");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src ${scriptSrc.join(" ")}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  );

  if (secureTransport) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

class LoginRateLimiter {
  constructor() {
    this.failures = new Map();
  }

  canAttempt(ip) {
    const entry = this.failures.get(ip);
    if (!entry) {
      return true;
    }
    return Date.now() >= entry.blockedUntil;
  }

  recordFailure(ip) {
    const current = this.failures.get(ip) ?? { count: 0, blockedUntil: 0 };
    const count = current.count + 1;
    const delay = Math.min(1000 * 60 * 10, 1000 * 2 ** count);
    this.failures.set(ip, {
      count,
      blockedUntil: Date.now() + delay,
    });
  }

  recordSuccess(ip) {
    this.failures.delete(ip);
  }
}

class FixedWindowRateLimiter {
  constructor({ windowMs = DEFAULT_RATE_LIMIT_WINDOW_MS, maxRequests = 60 } = {}) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.entries = new Map();
  }

  take(key) {
    const normalizedKey = String(key || "unknown");
    const now = Date.now();
    const current = this.entries.get(normalizedKey);

    if (!current || current.resetAt <= now) {
      const next = {
        count: 1,
        resetAt: now + this.windowMs,
      };
      this.entries.set(normalizedKey, next);
      return {
        allowed: true,
        remaining: this.maxRequests - next.count,
        retryAfterMs: this.windowMs,
      };
    }

    if (current.count >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, current.resetAt - now),
      };
    }

    current.count += 1;
    return {
      allowed: true,
      remaining: this.maxRequests - current.count,
      retryAfterMs: Math.max(0, current.resetAt - now),
    };
  }
}

class AuthManager {
  constructor({ password, ttlMs = DEFAULT_SESSION_TTL_MS }) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
    this.passwordSalt = randomBytes(16);
    this.passwordHash = scryptSync(password, this.passwordSalt, 32);
  }

  verifyPassword(candidate) {
    const candidateHash = scryptSync(candidate, this.passwordSalt, 32);
    return timingSafeEqual(candidateHash, this.passwordHash);
  }

  createSession() {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    this.sessions.set(token, {
      expiresAt: Date.now() + this.ttlMs,
      csrfToken,
    });
    return {
      token,
      csrfToken,
    };
  }

  consume(token) {
    const session = this.sessions.get(token);
    if (!session) {
      return null;
    }

    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }

    session.expiresAt = Date.now() + this.ttlMs;
    return session;
  }

  destroy(token) {
    this.sessions.delete(token);
  }

  setCookie(res, token, { secureCookies = false } = {}) {
    const parts = [
      `vorker_session=${encodeURIComponent(token)}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${Math.floor(this.ttlMs / 1000)}`,
    ];

    if (secureCookies) {
      parts.push("Secure");
    }

    res.setHeader("Set-Cookie", parts.join("; "));
  }

  clearCookie(res, { secureCookies = false } = {}) {
    const parts = ["vorker_session=", "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
    if (secureCookies) {
      parts.push("Secure");
    }
    res.setHeader("Set-Cookie", parts.join("; "));
  }
}

class EventLog {
  constructor({ maxEntries = MAX_EVENT_LOG_ENTRIES } = {}) {
    this.maxEntries = maxEntries;
    this.nextId = 1;
    this.entries = [];
    this.waiters = new Set();
  }

  publish(payload) {
    const entry = {
      id: this.nextId,
      ...payload,
    };
    this.nextId += 1;
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    for (const waiter of Array.from(this.waiters)) {
      const pending = this.getSince(waiter.since);
      if (pending.length > 0) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(pending);
      }
    }

    return entry;
  }

  getSince(since) {
    const cursor = Number.isFinite(since) ? since : 0;
    return this.entries.filter((entry) => entry.id > cursor);
  }

  async waitForSince(since, timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS) {
    const pending = this.getSince(since);
    if (pending.length > 0 || timeoutMs <= 0) {
      return pending;
    }

    return await new Promise((resolve) => {
      const waiter = {
        since,
        resolve: (entries) => {
          resolve(entries);
        },
        timer: null,
      };

      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve([]);
      }, timeoutMs);

      this.waiters.add(waiter);
    });
  }
}

function createPermissionBroker({ broadcast, timeoutMs = 1000 * 60 * 2 }) {
  const pending = new Map();

  return {
    async waitForDecision(agentId, request) {
      const requestId = randomUUID();

      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          broadcast({
            type: "permission_expired",
            agentId,
            requestId,
          });
          resolve({ outcome: { outcome: "cancelled" } });
        }, timeoutMs);

        pending.set(requestId, {
          options: request.options,
          resolve: (response) => {
            clearTimeout(timer);
            pending.delete(requestId);
            resolve(response);
          },
        });

        broadcast({
          type: "permission_request",
          agentId,
          requestId,
          toolCall: request.toolCall,
          options: request.options.map((option) => ({
            optionId: option.optionId,
            kind: option.kind,
            name: option.name,
          })),
        });
      });
    },
    resolve(requestId, optionId) {
      const entry = pending.get(requestId);
      if (!entry) {
        return false;
      }

      if (!optionId) {
        entry.resolve({ outcome: { outcome: "cancelled" } });
        return true;
      }

      const selected = entry.options.find((option) => option.optionId === optionId);
      if (!selected) {
        entry.resolve({ outcome: { outcome: "cancelled" } });
        return true;
      }

      entry.resolve({
        outcome: {
          outcome: "selected",
          optionId: selected.optionId,
        },
      });
      return true;
    },
  };
}

function normalizeServerOptions(options) {
  const host = options.host ?? "127.0.0.1";
  const port = Number.parseInt(String(options.port ?? "4173"), 10);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const copilotBin = options.copilotBin ?? process.env.COPILOT_BIN ?? "copilot";
  const tlsKeyPath = options.tlsKey ? path.resolve(options.tlsKey) : null;
  const tlsCertPath = options.tlsCert ? path.resolve(options.tlsCert) : null;
  const allowInsecureHttp = Boolean(options.allowInsecureHttp);
  const secureTransport = Boolean(tlsKeyPath && tlsCertPath);
  const trustProxy = Boolean(options.trustProxy);

  if (!secureTransport && !isLocalBinding(host) && host !== "0.0.0.0" && host !== "::") {
    throw new Error(`Host ${host} requires TLS or --allow-insecure-http.`);
  }

  if (!secureTransport && (host === "0.0.0.0" || host === "::") && !allowInsecureHttp) {
    throw new Error("Refusing to bind a public interface without TLS. Use --tls-key/--tls-cert or --allow-insecure-http.");
  }

  return {
    host,
    port,
    cwd,
    copilotBin,
    tlsKeyPath,
    tlsCertPath,
    secureTransport,
    allowInsecureHttp,
    trustProxy,
  };
}

function getRequestOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.trim()) {
    return origin.trim();
  }

  const referer = req.headers.referer;
  if (typeof referer !== "string" || !referer.trim()) {
    return null;
  }

  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function formatAgentEvent(event) {
  switch (event.type) {
    case "message_chunk":
      return {
        type: "message_chunk",
        agentId: event.agentId,
        messageId: event.messageId,
        text: event.text,
        content: event.content,
      };
    case "tool_call":
    case "tool_call_update":
      return {
        type: event.type,
        agentId: event.agentId,
        update: event.update,
      };
    case "plan":
      return {
        type: "plan",
        agentId: event.agentId,
        entries: event.entries,
      };
    case "usage":
      return {
        type: "usage",
        agentId: event.agentId,
        usage: event.usage,
      };
    case "agent_state":
      return {
        type: "agent_state",
        agentId: event.agentId,
        agent: event.agent,
      };
    case "prompt_started":
    case "prompt_finished":
    case "session_info":
    case "mode_changed":
    case "model_changed":
    case "initialized":
    case "permission_auto_selected":
    case "permission_denied":
    case "process_exit":
    case "terminal_output":
    case "terminal_exit":
    case "closed":
      return event;
    case "error":
      return {
        type: "agent_error",
        agentId: event.agentId,
        stage: event.stage,
        promptId: event.promptId ?? null,
        message: event.message,
      };
    default:
      return {
        type: "agent_update",
        agentId: event.agentId,
        event,
      };
  }
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function closeNodeServer(server) {
  if (!server?.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function closeWebSocketServer(server, clients) {
  for (const client of clients) {
    client.close();
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function getRequestSecurity(req, normalized) {
  if (normalized.secureTransport || req.socket.encrypted) {
    return true;
  }

  const trustForwardedHeaders = normalized.trustProxy || isLocalBinding(normalized.host);
  if (!trustForwardedHeaders) {
    return false;
  }

  const forwardedProto = parseForwardedProto(req);
  return forwardedProto === "https";
}

function getRequestBaseUrl(req, normalized) {
  const protocol = getRequestSecurity(req, normalized) ? "https" : "http";
  return `${protocol}://${req.headers.host ?? `${normalized.host}:${normalized.port}`}`;
}

function hasTrustedOrigin(req, normalized) {
  return getRequestOrigin(req) === getRequestBaseUrl(req, normalized);
}

function getCsrfHeader(req) {
  const value = req.headers["x-vorker-csrf"];
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? "";
  }
  return "";
}

function hasValidCsrf(session, req) {
  return Boolean(session?.csrfToken) && getCsrfHeader(req) === session.csrfToken;
}

function sendRateLimited(res, retryAfterMs, message = "Too many requests. Try again later.") {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  sendJson(
    res,
    429,
    { error: message },
    {
      "Retry-After": String(retryAfterSeconds),
    },
  );
}

export async function startRemoteServer(options) {
  const normalized = normalizeServerOptions(options);
  const nextBuildExists = await fs
    .access(path.join(normalized.cwd, ".next"))
    .then(() => true)
    .catch(() => false);
  const nextDevMode = process.env.NODE_ENV === "development" || !nextBuildExists;
  const nextApp = next({
    dev: nextDevMode,
    dir: normalized.cwd,
    quiet: true,
  });
  await nextApp.prepare();
  const nextHandler = nextApp.getRequestHandler();
  const pairingPassword = process.env.VORKER_PASSWORD ?? randomBytes(12).toString("base64url");
  const auth = new AuthManager({
    password: pairingPassword,
  });
  const loginRateLimiter = new LoginRateLimiter();
  const requestRateLimiters = {
    loginWindow: new FixedWindowRateLimiter({ maxRequests: 20 }),
    sessionProbe: new FixedWindowRateLimiter({ maxRequests: 90 }),
    bootstrap: new FixedWindowRateLimiter({ maxRequests: 60 }),
    events: new FixedWindowRateLimiter({ maxRequests: 180 }),
    command: new FixedWindowRateLimiter({ maxRequests: 120 }),
    websocketUpgrade: new FixedWindowRateLimiter({ maxRequests: 30 }),
  };
  const skillCatalog = new SkillCatalog({
    cwd: normalized.cwd,
  });
  const manager = new CopilotManager({
    cwd: normalized.cwd,
    copilotBin: normalized.copilotBin,
    skillCatalog,
  });
  const orchestrator = new Orchestrator({
    manager,
  });
  const eventLog = new EventLog();
  const wsClients = new Set();
  const tunnelManager = new TunnelManager({
    port: normalized.port,
    protocol: normalized.secureTransport ? "https" : "http",
    host: "127.0.0.1",
    cloudflaredBin: options.cloudflaredBin,
    edgeProtocol: options.cloudflaredProtocol,
    edgeIpVersion: options.cloudflaredEdgeIpVersion,
  });
  const supervisorEventLog = new PersistentSupervisorEventLog({
    rootDir: path.join(normalized.cwd, ".vorker-2", "logs"),
    filePath: path.join(normalized.cwd, ".vorker-2", "logs", "supervisor.ndjson"),
  });
  const supervisor = new SupervisorService({
    manager,
    orchestrator,
    tunnelManager,
    skillCatalog,
    eventLog: supervisorEventLog,
  });

  const broadcast = (payload) => {
    eventLog.publish(payload);
    const message = JSON.stringify(payload);
    for (const client of wsClients) {
      if (client.readyState === 1) {
        client.send(message);
      }
    }
  };

  const permissionBroker = createPermissionBroker({ broadcast });
  const shouldBlockClientAutoApprove = () =>
    process.env.VORKER_ALLOW_REMOTE_AUTO_APPROVE !== "1" && (normalized.trustProxy || tunnelManager.state !== "idle");
  const disableAllAgentAutoApprove = async () => {
    const agentsWithAutoApprove = manager.listAgents().filter((agent) => agent.autoApprove);
    await Promise.all(
      agentsWithAutoApprove.map(async (agent) => {
        await manager.updateAgent(agent.id, { autoApprove: false });
      }),
    );
  };

  const refreshSkills = async () => {
    skillCatalog.setWorkspaceRoots([normalized.cwd, ...manager.listAgents().map((agent) => agent.cwd)]);
    const skills = await skillCatalog.refresh();
    await supervisor.refreshSkills();
    broadcast({
      type: "skills_updated",
      skills,
      lastRefreshedAt: skillCatalog.lastRefreshedAt,
    });
    return skills;
  };

  const snapshotBootstrap = (secureTransport, authenticated) => ({
    authenticated,
    secureTransport,
    cwd: normalized.cwd,
    pairingPassword: authenticated ? pairingPassword : undefined,
    agents: authenticated ? manager.listAgents() : [],
    runs: authenticated ? orchestrator.listRuns() : [],
    skills: authenticated ? skillCatalog.listSkills() : [],
    share: authenticated ? tunnelManager.snapshot() : null,
    supervisor: authenticated ? supervisor.snapshot() : null,
    events: authenticated ? eventLog.getSince(0) : [],
  });

  const fireAndBroadcast = async (work, errorPayload) => {
    try {
      await work();
    } catch (error) {
      broadcast({
        type: "error",
        message: safeError(error),
        ...errorPayload,
      });
    }
  };

  const handleClientCommand = async (payload) => {
    switch (payload.type) {
      case "list_agents":
        return { type: "agents", agents: manager.listAgents() };
      case "list_runs":
        return { type: "runs", runs: orchestrator.listRuns() };
      case "list_skills":
        return { type: "skills_updated", skills: skillCatalog.listSkills(), lastRefreshedAt: skillCatalog.lastRefreshedAt };
      case "create_agent": {
        const cwd = payload.cwd ? path.resolve(String(payload.cwd)) : normalized.cwd;
        const agent = await manager.createAgent({
          name: payload.name ? String(payload.name) : undefined,
          cwd,
          mode: payload.mode ? String(payload.mode) : null,
          model: payload.model ? String(payload.model) : null,
          role: payload.role ? String(payload.role) : "worker",
          notes: payload.notes ? String(payload.notes) : "",
          skillIds: Array.isArray(payload.skillIds) ? payload.skillIds.map((value) => String(value)) : [],
          autoApprove: shouldBlockClientAutoApprove() ? false : Boolean(payload.autoApprove),
          permissionHandler: async ({ request, agent: session }) =>
            await permissionBroker.waitForDecision(session.id, request),
        });
        await refreshSkills();

        return { type: "create_agent_ok", agent: agent.snapshot() };
      }
      case "update_agent": {
        const session = await manager.updateAgent(String(payload.agentId ?? ""), {
          name: payload.name ? String(payload.name) : undefined,
          role: payload.role ? String(payload.role) : undefined,
          notes: typeof payload.notes === "string" ? String(payload.notes) : undefined,
          skillIds: Array.isArray(payload.skillIds) ? payload.skillIds.map((value) => String(value)) : undefined,
          mode: payload.mode ? String(payload.mode) : undefined,
          model: payload.model ? String(payload.model) : undefined,
          autoApprove:
            typeof payload.autoApprove === "boolean"
              ? shouldBlockClientAutoApprove()
                ? false
                : payload.autoApprove
              : undefined,
        });
        await refreshSkills();
        return { type: "agent_state", agent: session.snapshot() };
      }
      case "send_prompt": {
        const text = String(payload.text ?? "").trim();

        if (!text) {
          throw new Error("Prompt text is required.");
        }

        void fireAndBroadcast(
          async () => {
            await manager.promptAgent(String(payload.agentId), text, {
              displayText: text,
            });
          },
          { agentId: String(payload.agentId ?? "") },
        );
        return { type: "ok" };
      }
      case "set_mode": {
        const session = await manager.updateAgent(String(payload.agentId ?? ""), {
          mode: String(payload.modeId ?? ""),
        });
        return { type: "agent_state", agent: session.snapshot() };
      }
      case "set_model": {
        const session = await manager.updateAgent(String(payload.agentId ?? ""), {
          model: String(payload.modelId ?? ""),
        });
        return { type: "agent_state", agent: session.snapshot() };
      }
      case "close_agent":
        await manager.closeAgent(String(payload.agentId));
        return { type: "ok" };
      case "refresh_skills": {
        const skills = await refreshSkills();
        return { type: "skills_updated", skills, lastRefreshedAt: skillCatalog.lastRefreshedAt };
      }
      case "create_run": {
        const run = orchestrator.createRun({
          name: payload.name,
          goal: payload.goal,
          workspace: payload.workspace ?? normalized.cwd,
          arbitratorAgentId: payload.arbitratorAgentId,
          workerAgentIds: payload.workerAgentIds,
          notes: payload.notes,
        });
        return { type: "run_created", run };
      }
      case "update_run": {
        const run = orchestrator.updateRun(String(payload.runId ?? ""), payload);
        return { type: "run_updated", run };
      }
      case "plan_run":
        void fireAndBroadcast(
          async () => {
            await orchestrator.planRun(String(payload.runId ?? ""));
          },
          { runId: String(payload.runId ?? "") },
        );
        return { type: "ok" };
      case "create_task": {
        const task = orchestrator.createTask({
          runId: payload.runId,
          title: payload.title,
          description: payload.description,
          status: payload.status,
          assignedAgentId: payload.assignedAgentId,
          skillIds: payload.skillIds,
          modeId: payload.modeId,
          modelId: payload.modelId,
        });
        return { type: "task_created", task, run: orchestrator.snapshotRun(task.runId) };
      }
      case "update_task": {
        const task = orchestrator.updateTask(String(payload.taskId ?? ""), payload);
        return { type: "task_updated", task, run: orchestrator.snapshotRun(task.runId) };
      }
      case "dispatch_task":
        void fireAndBroadcast(
          async () => {
            await orchestrator.dispatchTask(String(payload.taskId ?? ""), {
              agentId: payload.agentId,
              modeId: payload.modeId,
              modelId: payload.modelId,
            });
          },
          { taskId: String(payload.taskId ?? "") },
        );
        return { type: "ok" };
      case "merge_task":
        void fireAndBroadcast(
          async () => {
            await orchestrator.mergeTask(String(payload.taskId ?? ""));
          },
          { taskId: String(payload.taskId ?? "") },
        );
        return { type: "ok" };
      case "auto_dispatch_run":
        void fireAndBroadcast(
          async () => {
            await orchestrator.autoDispatchReadyTasks(String(payload.runId ?? ""));
          },
          { runId: String(payload.runId ?? "") },
        );
        return { type: "ok" };
      case "merge_run":
        void fireAndBroadcast(
          async () => {
            await orchestrator.mergeCompletedTasks(String(payload.runId ?? ""));
          },
          { runId: String(payload.runId ?? "") },
        );
        return { type: "ok" };
      case "share_start":
        void fireAndBroadcast(
          async () => {
            await disableAllAgentAutoApprove();
            await tunnelManager.start({
              cloudflaredBin: payload.cloudflaredBin ? String(payload.cloudflaredBin) : undefined,
              edgeProtocol: payload.edgeProtocol ? String(payload.edgeProtocol) : undefined,
              edgeIpVersion: payload.edgeIpVersion ? String(payload.edgeIpVersion) : undefined,
            });
          },
          {},
        );
        return { type: "ok" };
      case "share_stop":
        await tunnelManager.stop();
        return { type: "share_state", share: tunnelManager.snapshot() };
      case "permission_response": {
        const resolved = permissionBroker.resolve(
          String(payload.requestId ?? ""),
          payload.outcome === "selected" ? String(payload.optionId ?? "") : null,
        );

        if (!resolved) {
          throw new Error("Permission request is no longer pending.");
        }

        return { type: "ok" };
      }
      default:
        throw new Error(`Unknown message type: ${payload.type}`);
    }
  };

  await restoreDurableSupervisorState({
    eventLog: supervisorEventLog,
    orchestrator,
    store: supervisor.store,
  });
  await supervisor.start();
  await refreshSkills();

  manager.on("agent_created", ({ agent }) => {
    broadcast({
      type: "agent_created",
      agent,
    });
  });

  manager.on("agents_changed", ({ agents }) => {
    broadcast({
      type: "agents",
      agents,
    });
  });

  manager.on("agent_event", (event) => {
    broadcast(formatAgentEvent(event));
  });

  orchestrator.on("event", (event) => {
    broadcast(event);
  });

  tunnelManager.on("event", (event) => {
    broadcast(event);
  });

  const requestHandler = async (req, res) => {
    const secureTransport = getRequestSecurity(req, normalized);
    applySecurityHeaders(res, secureTransport);

    const url = new URL(req.url, "http://localhost");
    const cookies = parseCookies(req.headers.cookie ?? "");
    const session = cookies.vorker_session ? auth.consume(cookies.vorker_session) : null;
    const ip = requestIp(req);
    const sessionOrIpKey = session ? `session:${cookies.vorker_session}` : `ip:${ip}`;

    if (url.pathname === "/api/login" && req.method === "POST") {
      if (!hasTrustedOrigin(req, normalized)) {
        sendJson(res, 403, { error: "Cross-origin login requests are not allowed." });
        return;
      }

      if (!hasJsonContentType(req)) {
        sendJson(res, 415, { error: "Expected application/json request body." });
        return;
      }

      const loginWindow = requestRateLimiters.loginWindow.take(`ip:${ip}`);
      if (!loginWindow.allowed) {
        sendRateLimited(res, loginWindow.retryAfterMs);
        return;
      }

      if (!loginRateLimiter.canAttempt(ip)) {
        sendJson(res, 429, { error: "Too many login attempts. Try again later." });
        return;
      }

      try {
        const body = await readJsonBody(req);
        const password = String(body.password ?? "");
        if (!auth.verifyPassword(password)) {
          loginRateLimiter.recordFailure(ip);
          sendJson(res, 401, { error: "Invalid password." });
          return;
        }

        loginRateLimiter.recordSuccess(ip);
        const createdSession = auth.createSession();
        auth.setCookie(res, createdSession.token, { secureCookies: secureTransport });
        sendJson(res, 200, {
          ok: true,
          secureTransport,
          cwd: normalized.cwd,
          csrfToken: createdSession.csrfToken,
        });
      } catch (error) {
        sendJson(res, 400, { error: safeError(error) });
      }
      return;
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      if (!session) {
        auth.clearCookie(res, { secureCookies: secureTransport });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (!hasTrustedOrigin(req, normalized) || !hasValidCsrf(session, req)) {
        sendJson(res, 403, { error: "Invalid logout request." });
        return;
      }

      if (cookies.vorker_session) {
        auth.destroy(cookies.vorker_session);
      }
      auth.clearCookie(res, { secureCookies: secureTransport });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/me" && req.method === "GET") {
      const sessionProbe = requestRateLimiters.sessionProbe.take(`ip:${ip}`);
      if (!sessionProbe.allowed) {
        sendRateLimited(res, sessionProbe.retryAfterMs);
        return;
      }

      sendJson(res, 200, {
        authenticated: Boolean(session),
        secureTransport,
        transportMode: secureTransport ? "secure" : "local",
        cwd: normalized.cwd,
        csrfToken: session?.csrfToken ?? "",
      });
      return;
    }

    if (url.pathname === "/api/bootstrap" && req.method === "GET") {
      if (!session) {
        sendJson(res, 401, { error: "Authentication required." });
        return;
      }

      const bootstrapLimit = requestRateLimiters.bootstrap.take(sessionOrIpKey);
      if (!bootstrapLimit.allowed) {
        sendRateLimited(res, bootstrapLimit.retryAfterMs);
        return;
      }

      sendJson(res, 200, {
        ...snapshotBootstrap(secureTransport, true),
        csrfToken: session.csrfToken,
      });
      return;
    }

    if (url.pathname === "/api/agents" && req.method === "GET") {
      if (!session) {
        sendJson(res, 401, { error: "Authentication required." });
        return;
      }

      sendJson(res, 200, {
        agents: manager.listAgents(),
      });
      return;
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      if (!session) {
        sendJson(res, 401, { error: "Authentication required." });
        return;
      }

      const eventsLimit = requestRateLimiters.events.take(sessionOrIpKey);
      if (!eventsLimit.allowed) {
        sendRateLimited(res, eventsLimit.retryAfterMs);
        return;
      }

      const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
      const timeoutMs = Math.min(
        DEFAULT_LONG_POLL_TIMEOUT_MS,
        Math.max(0, Number.parseInt(url.searchParams.get("timeoutMs") ?? String(DEFAULT_LONG_POLL_TIMEOUT_MS), 10) || 0),
      );
      const events = await eventLog.waitForSince(Number.isFinite(since) ? since : 0, timeoutMs);
      sendJson(res, 200, {
        events,
        cursor: events.at(-1)?.id ?? (Number.isFinite(since) ? since : 0),
        secureTransport,
      });
      return;
    }

    if (url.pathname === "/api/command" && req.method === "POST") {
      if (!session) {
        sendJson(res, 401, { error: "Authentication required." });
        return;
      }

      if (!hasTrustedOrigin(req, normalized) || !hasValidCsrf(session, req)) {
        sendJson(res, 403, { error: "Invalid cross-site or forged command request." });
        return;
      }

      if (!hasJsonContentType(req)) {
        sendJson(res, 415, { error: "Expected application/json request body." });
        return;
      }

      const commandLimit = requestRateLimiters.command.take(sessionOrIpKey);
      if (!commandLimit.allowed) {
        sendRateLimited(res, commandLimit.retryAfterMs);
        return;
      }

      try {
        const payload = await readJsonBody(req);
        const response = await handleClientCommand(payload);
        sendJson(res, 200, {
          ok: true,
          response,
        });
      } catch (error) {
        sendJson(res, 400, { error: safeError(error) });
      }
      return;
    }

    await nextHandler(req, res);
  };

  let server;
  if (normalized.secureTransport) {
    const [key, cert] = await Promise.all([
      fs.readFile(normalized.tlsKeyPath),
      fs.readFile(normalized.tlsCertPath),
    ]);
    server = createHttpsServer({ key, cert }, requestHandler);
  } else {
    server = createHttpServer(requestHandler);
  }

  const wsServer = new WebSocketServer({ noServer: true });

  wsServer.on("connection", (ws, req) => {
    wsClients.add(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        secureTransport: getRequestSecurity(req, normalized),
        cwd: normalized.cwd,
        agents: manager.listAgents(),
        runs: orchestrator.listRuns(),
        skills: skillCatalog.listSkills(),
        share: tunnelManager.snapshot(),
      }),
    );

    ws.on("message", async (raw) => {
      const sessionToken = typeof req.vorkerSessionToken === "string" ? req.vorkerSessionToken : "";
      if (!sessionToken || !auth.consume(sessionToken)) {
        ws.send(JSON.stringify({ type: "error", message: "Session expired. Re-authentication required." }));
        ws.close();
        return;
      }

      let payload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON payload." }));
        return;
      }

      try {
        const response = await handleClientCommand(payload);
        if (response.type !== "ok") {
          ws.send(JSON.stringify(response));
        }
      } catch (error) {
        ws.send(JSON.stringify({ type: "error", message: safeError(error) }));
      }
    });

    ws.on("close", () => {
      wsClients.delete(ws);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const wsLimit = requestRateLimiters.websocketUpgrade.take(`ip:${requestIp(req)}`);
    if (!wsLimit.allowed) {
      socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${Math.max(1, Math.ceil(wsLimit.retryAfterMs / 1000))}\r\n\r\n`);
      socket.destroy();
      return;
    }

    const cookies = parseCookies(req.headers.cookie ?? "");
    const token = cookies.vorker_session;
    const session = token ? auth.consume(token) : null;
    if (!token || !session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const origin = req.headers.origin;
    const expectedOrigin = getRequestBaseUrl(req, normalized);
    if (!origin || origin !== expectedOrigin) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    const csrfToken = url.searchParams.get("csrf")?.trim() ?? "";
    if (!csrfToken || csrfToken !== session.csrfToken) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    req.vorkerSessionToken = token;
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      wsServer.emit("connection", ws, req);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(normalized.port, normalized.host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address && typeof address !== "string" && Number.isInteger(address.port) && address.port > 0) {
        normalized.port = address.port;
        tunnelManager.setPort(address.port);
      }
      resolve();
    });
  });

  const protocol = normalized.secureTransport ? "https" : "http";
  const displayHost = normalized.host === "0.0.0.0" ? "localhost" : normalized.host;

  process.stderr.write(`Remote server listening on ${protocol}://${displayHost}:${normalized.port}\n`);
  process.stderr.write(`Workspace: ${normalized.cwd}\n`);
  if (process.env.VORKER_PASSWORD) {
    process.stderr.write("Using password from VORKER_PASSWORD\n");
  } else {
    process.stderr.write(`Generated pairing password: ${pairingPassword}\n`);
  }
  if (!normalized.secureTransport) {
    process.stderr.write("Transport is HTTP/WS. This is safe only on localhost unless you explicitly opted into insecure public access.\n");
  }

  const shutdown = async () => {
    removeSignalHandlers();
    await tunnelManager.stop().catch(() => {});
    await supervisor.close();
    await manager.closeAll();
    await closeWebSocketServer(wsServer, wsClients).catch(() => {});
    await closeNodeServer(server);
    if (typeof nextApp.close === "function") {
      await nextApp.close();
    }
  };

  let signalHandlersInstalled = false;
  const handleSigint = () => {
    void shutdown().finally(() => process.exit(0));
  };
  const handleSigterm = () => {
    void shutdown().finally(() => process.exit(0));
  };
  const removeSignalHandlers = () => {
    if (!signalHandlersInstalled) {
      return;
    }
    signalHandlersInstalled = false;
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);
  };

  if (options.installSignalHandlers !== false) {
    process.on("SIGINT", handleSigint);
    process.on("SIGTERM", handleSigterm);
    signalHandlersInstalled = true;
  }

  return {
    server,
    shutdown,
    pairingPassword,
    normalized,
    manager,
    orchestrator,
    skillCatalog,
    supervisor,
    tunnelManager,
  };
}
