import http from "node:http";
import crypto from "node:crypto";
import WebSocket from "ws";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 39210);
const WS_BASE = "wss://game-log-api-live.dndbeyond.com/v1";
const REST_MESSAGES = "https://game-log-rest-live.dndbeyond.com/v1/getmessages";
const ACTIVE_CHARACTERS = "https://www.dndbeyond.com/api/campaign/stt/active-short-characters/";
const ROLL_EVENT = "dice/roll/fulfilled";
const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000];
const REFRESH_LEAD_MS = 40000;
const HEALTHY_AFTER_MS = 15000;
const MAX_SEEN = 3000;
const accessToken = crypto.randomBytes(32).toString("hex");
const allowedExtraOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

let config = null;
let socket = null;
let reconnectTimer = null;
let refreshTimer = null;
let healthyTimer = null;
let stopped = true;
let failures = 0;
let state = "idle";
let lastError = "";
let seen = new Set();
const clients = new Set();

function log(message) {
  // Never log cookies, bearer tokens, JWTs, or complete game-log messages.
  console.log(`[ddb-direct-bridge] ${message}`);
}

function allowedOrigin(origin) {
  if (!origin) return true;
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host === "forge-vtt.com" || host.endsWith(".forge-vtt.com")) return true;
  return allowedExtraOrigins.includes(origin);
}

function cors(req, res) {
  const origin = req.headers.origin || "";
  if (allowedOrigin(origin)) {
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function authorized(req, url) {
  const header = String(req.headers.authorization || "");
  const queryToken = url.searchParams.get("token") || "";
  return header === `Bearer ${accessToken}` || queryToken === accessToken;
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error("Request body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function cleanCookie(value) {
  let cookie = String(value || "").trim();
  cookie = cookie.replace(/^CobaltSession\s*=\s*/i, "");
  if (!cookie || /[\r\n;]/.test(cookie)) throw new Error("Enter only the CobaltSession cookie value, not a full Cookie header.");
  return cookie;
}

function decodeJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch { return {}; }
}

function extractUserId(claims) {
  const candidates = [
    claims.nameidentifier,
    claims["nameidentifier"],
    claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"],
    claims.sub
  ];
  return String(candidates.find(v => v !== undefined && v !== null && String(v).length) || "");
}

async function mintToken() {
  if (!config?.cobaltSession) throw new Error("CobaltSession has not been configured.");
  const response = await fetch("https://auth-service.dndbeyond.com/v1/cobalt-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": `CobaltSession=${config.cobaltSession}`,
      "Origin": "https://www.dndbeyond.com",
      "User-Agent": "Mozilla/5.0 DDB-Foundry-Direct-Bridge"
    },
    body: "{}"
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`D&D Beyond token exchange failed (HTTP ${response.status}). Check that the CobaltSession cookie is current.${detail ? " " + detail.slice(0, 120) : ""}`);
  }
  const payload = await response.json();
  const token = String(payload.token || payload.data?.token || "");
  if (!token) throw new Error("D&D Beyond returned no authentication token.");
  const claims = decodeJwt(token);
  const userId = extractUserId(claims);
  if (!userId) throw new Error("Could not read the D&D Beyond user ID from the authentication token.");
  const exp = Number(claims.exp || 0) * 1000;
  return { token, userId, expiresAt: exp || Date.now() + 300000 };
}

async function apiFetch(url, token, includeCookie = false) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (includeCookie) headers.Cookie = `CobaltSession=${config.cobaltSession}`;
  return fetch(url, { headers });
}

function broadcast(eventName, payload) {
  const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try { client.write(frame); } catch { clients.delete(client); }
  }
}

function setStatus(nextState, error = lastError) {
  state = nextState;
  lastError = error;
  broadcast("status", { state, failures, lastError, gameId: config?.gameId || "" });
}

function remember(id) {
  if (!id || seen.has(id)) return false;
  seen.add(id);
  if (seen.size > MAX_SEEN) {
    const iterator = seen.values();
    while (seen.size > 2200) {
      const oldest = iterator.next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
  }
  return true;
}

async function seedHistory(auth) {
  try {
    const url = new URL(REST_MESSAGES);
    url.searchParams.set("gameId", config.gameId);
    url.searchParams.set("userId", auth.userId);
    const response = await apiFetch(url, auth.token);
    if (!response.ok) {
      log(`History dedup seed skipped (HTTP ${response.status}).`);
      return;
    }
    const body = await response.json();
    for (const message of body.data || []) if (message?.id) remember(String(message.id));
    log(`Seeded ${seen.size} prior game-log event IDs.`);
  } catch (error) {
    log(`History dedup seed skipped: ${error.message}`);
  }
}

function clearTimers() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (refreshTimer) clearTimeout(refreshTimer);
  if (healthyTimer) clearTimeout(healthyTimer);
  reconnectTimer = refreshTimer = healthyTimer = null;
}

function closeSocket() {
  const old = socket;
  socket = null;
  if (old) {
    old.removeAllListeners();
    try { old.close(); } catch {}
  }
}

function stopPump() {
  stopped = true;
  clearTimers();
  closeSocket();
  setStatus("stopped", "");
}

function markHealthy() {
  if (healthyTimer) clearTimeout(healthyTimer);
  healthyTimer = null;
  failures = 0;
  lastError = "";
}

function scheduleReconnect(reason) {
  if (stopped) return;
  clearTimers();
  closeSocket();
  const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
  failures += 1;
  setStatus("retrying", reason);
  log(`${reason}; reconnecting in ${delay}ms (failure ${failures}).`);
  reconnectTimer = setTimeout(() => { void connect(); }, delay);
}

function handleFrame(raw) {
  let message;
  try { message = JSON.parse(String(raw)); } catch { return; }
  if (message.eventType !== ROLL_EVENT || !message.id) return;
  if (config?.skipBeyond20 && message.data?.__b20Override__ === true) return;
  if (!remember(String(message.id))) return;
  broadcast("roll", message);
}

async function connect() {
  if (stopped || !config?.gameId) return;
  setStatus("connecting", "");
  let auth;
  try {
    auth = await mintToken();
  } catch (error) {
    scheduleReconnect(`Authentication failed: ${error.message}`);
    return;
  }

  const url = new URL(WS_BASE);
  url.searchParams.set("gameId", config.gameId);
  url.searchParams.set("userId", auth.userId);
  url.searchParams.set("stt", auth.token);
  const ws = new WebSocket(url, {
    headers: { Origin: "https://www.dndbeyond.com", "User-Agent": "Mozilla/5.0" }
  });
  socket = ws;

  ws.on("open", () => {
    if (socket !== ws || stopped) return;
    setStatus("connected", "");
    log(`Connected to D&D Beyond game log for campaign ${config.gameId}.`);
    healthyTimer = setTimeout(markHealthy, HEALTHY_AFTER_MS);
    const lifetime = Math.max(30000, auth.expiresAt - Date.now() - REFRESH_LEAD_MS);
    refreshTimer = setTimeout(() => {
      if (stopped) return;
      closeSocket();
      void connect();
    }, lifetime);
  });
  ws.on("message", data => {
    if (socket !== ws || stopped) return;
    markHealthy();
    handleFrame(data);
  });
  ws.on("error", error => {
    if (socket !== ws) return;
    lastError = error.message || "WebSocket error";
    log(`WebSocket error: ${lastError}`);
  });
  ws.on("close", code => {
    if (socket !== ws || stopped) return;
    scheduleReconnect(`D&D Beyond WebSocket closed (${code})`);
  });
}

async function startPump() {
  if (!config?.gameId || !config?.cobaltSession) throw new Error("Set a campaign ID and CobaltSession cookie first.");
  stopPump();
  stopped = false;
  failures = 0;
  seen = new Set();
  try {
    const auth = await mintToken();
    await seedHistory(auth);
  } catch (error) {
    log(`Could not seed history: ${error.message}`);
  }
  await connect();
}

async function listCharacters() {
  if (!config?.gameId) throw new Error("Set a campaign ID first.");
  const auth = await mintToken();
  const url = ACTIVE_CHARACTERS + encodeURIComponent(config.gameId);
  const response = await apiFetch(url, auth.token, true);
  if (!response.ok) throw new Error(`Could not read campaign characters (HTTP ${response.status}).`);
  const payload = await response.json();
  return (payload.data || []).map(c => ({
    id: String(c.id ?? ""),
    name: String(c.name ?? "Unknown"),
    userId: String(c.userId ?? ""),
    userName: String(c.userName ?? ""),
    avatarUrl: String(c.avatarUrl ?? "")
  })).filter(c => c.id);
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (req.method === "OPTIONS") {
    if (!allowedOrigin(req.headers.origin || "")) return send(res, 403, { error: "Origin not allowed." });
    res.writeHead(204);
    return res.end();
  }
  if (!allowedOrigin(req.headers.origin || "")) return send(res, 403, { error: "Origin not allowed. Set ALLOWED_ORIGINS if your Foundry host uses a custom domain." });

  if (url.pathname === "/health" && req.method === "GET") {
    return send(res, 200, { ok: true, service: "ddb-foundry-direct-bridge", state, version: "0.1.0" });
  }
  if (!authorized(req, url)) return send(res, 401, { error: "Unauthorized local bridge request." });

  try {
    if (url.pathname === "/configure" && req.method === "POST") {
      const body = await readJson(req);
      const gameId = String(body.gameId || "").trim();
      if (!/^\d{1,20}$/.test(gameId)) return send(res, 400, { error: "Campaign ID must be a numeric D&D Beyond campaign ID." });
      const cobaltSession = cleanCookie(body.cobaltSession);
      stopPump();
      config = { gameId, cobaltSession, skipBeyond20: body.skipBeyond20 !== false };
      await mintToken(); // Validate the cookie now; history is seeded once when capture starts.
      return send(res, 200, { ok: true, gameId, skipBeyond20: config.skipBeyond20, state });
    }
    if (url.pathname === "/start" && req.method === "POST") {
      await startPump();
      return send(res, 200, { ok: true, state });
    }
    if (url.pathname === "/stop" && req.method === "POST") {
      stopPump();
      return send(res, 200, { ok: true, state });
    }
    if (url.pathname === "/status" && req.method === "GET") {
      return send(res, 200, { ok: true, state, failures, lastError, gameId: config?.gameId || "" });
    }
    if (url.pathname === "/characters" && req.method === "GET") {
      return send(res, 200, { ok: true, characters: await listCharacters() });
    }
    if (url.pathname === "/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.write(`event: status\ndata: ${JSON.stringify({ state, failures, lastError, gameId: config?.gameId || "" })}\n\n`);
      clients.add(res);
      const heartbeat = setInterval(() => { try { res.write(": keepalive\n\n"); } catch {} }, 20000);
      req.on("close", () => { clearInterval(heartbeat); clients.delete(res); });
      return;
    }
    return send(res, 404, { error: "Not found." });
  } catch (error) {
    return send(res, 400, { error: String(error?.message || error) });
  }
});

server.listen(PORT, HOST, () => {
  log(`Listening only on http://${HOST}:${PORT}`);
  log(`Bridge access token (paste into the Foundry module once per server run): ${accessToken}`);
  log("The CobaltSession cookie is held in memory only and is never written to disk or printed.");
  log("If using a custom Foundry domain, set ALLOWED_ORIGINS to a comma-separated list of exact origins.");
});

process.on("SIGINT", () => { stopPump(); server.close(() => process.exit(0)); });
process.on("SIGTERM", () => { stopPump(); server.close(() => process.exit(0)); });
