// service/main.ts
import http from "node:http";

// service/stats.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.round(value);
}
function toInteger(value, fallback) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return fallback;
  }
  return value;
}
function toStringOr(value, fallback) {
  return typeof value === "string" ? value : fallback;
}
function toStringArray(value) {
  if (!Array.isArray(value))
    return [];
  return value.filter((entry) => typeof entry === "string");
}
function emptyUsage() {
  return {
    calls: 0,
    providerCalls: 0,
    estimatedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0
  };
}
function normalizeUsage(value) {
  if (!isRecord(value))
    return emptyUsage();
  return {
    calls: toCount(value.calls),
    providerCalls: toCount(value.providerCalls),
    estimatedCalls: toCount(value.estimatedCalls),
    inputTokens: toCount(value.inputTokens),
    outputTokens: toCount(value.outputTokens),
    cacheReadTokens: toCount(value.cacheReadTokens),
    cacheWriteTokens: toCount(value.cacheWriteTokens),
    reasoningTokens: toCount(value.reasoningTokens)
  };
}
function addUsage(a, b) {
  return {
    calls: a.calls + b.calls,
    providerCalls: a.providerCalls + b.providerCalls,
    estimatedCalls: a.estimatedCalls + b.estimatedCalls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens
  };
}
function collectActiveBlocks(messages) {
  const blocksById = isRecord(messages.blocksById) ? messages.blocksById : {};
  const entries = [];
  for (const [key, value] of Object.entries(blocksById)) {
    if (!isRecord(value) || value.active !== true)
      continue;
    const fallbackId = Number.parseInt(key, 10);
    const topic = typeof value.topic === "string" && value.topic.length > 0 ? value.topic : toStringOr(value.batchTopic, "");
    entries.push({
      blockId: toInteger(value.blockId, Number.isInteger(fallbackId) ? fallbackId : 0),
      topic,
      compressedTokens: toCount(value.compressedTokens),
      summaryTokens: toCount(value.summaryTokens),
      durationMs: toCount(value.durationMs),
      toolCount: toStringArray(value.effectiveToolIds).length,
      messageCount: toStringArray(value.effectiveMessageIds).length,
      createdAt: toCount(value.createdAt),
      toolIds: toStringArray(value.effectiveToolIds)
    });
  }
  entries.sort((a, b) => a.blockId - b.blockId);
  return entries;
}
function countPrunedMessages(messages) {
  if (!isRecord(messages.byMessageId))
    return 0;
  let count = 0;
  for (const entry of Object.values(messages.byMessageId)) {
    if (isRecord(entry) && Array.isArray(entry.activeBlockIds) && entry.activeBlockIds.length > 0) {
      count++;
    }
  }
  return count;
}
function buildSessionReport(state, sessionId) {
  if (!isRecord(state))
    return null;
  const prune = isRecord(state.prune) ? state.prune : null;
  const stats = isRecord(state.stats) ? state.stats : null;
  if (!prune || !stats)
    return null;
  if (!isRecord(prune.tools) || !isRecord(prune.messages))
    return null;
  const messages = prune.messages;
  const blocks = collectActiveBlocks(messages);
  const tools = new Set;
  if (isRecord(prune.tools)) {
    for (const toolId of Object.keys(prune.tools))
      tools.add(toolId);
  }
  for (const block of blocks) {
    for (const toolId of block.toolIds)
      tools.add(toolId);
  }
  const tokensOut = blocks.reduce((total, block) => total + block.summaryTokens, 0);
  const durationMs = blocks.reduce((total, block) => total + block.durationMs, 0);
  return {
    id: sessionId,
    found: true,
    sessionName: typeof state.sessionName === "string" ? state.sessionName : null,
    lastUpdated: typeof state.lastUpdated === "string" ? state.lastUpdated : null,
    tokensIn: toCount(stats.totalPruneTokens),
    tokensOut,
    durationMs,
    messages: countPrunedMessages(messages),
    tools: tools.size,
    usage: normalizeUsage(stats.compressionUsage),
    blocks: blocks.map(({ toolIds: _toolIds, ...block }) => block)
  };
}
function aggregateAllTime(states) {
  const result = {
    tokens: 0,
    tools: 0,
    messages: 0,
    sessions: 0,
    usage: emptyUsage()
  };
  for (const state of states) {
    if (!isRecord(state))
      continue;
    const prune = isRecord(state.prune) ? state.prune : null;
    if (!prune)
      continue;
    const stats = isRecord(state.stats) ? state.stats : null;
    const usage = normalizeUsage(stats?.compressionUsage);
    const tokens = toCount(stats?.totalPruneTokens);
    if (tokens === 0 && usage.calls === 0)
      continue;
    result.tokens += tokens;
    result.tools += isRecord(prune.tools) ? Object.keys(prune.tools).length : 0;
    const messages = isRecord(prune.messages) ? prune.messages : {};
    result.messages += isRecord(messages.byMessageId) ? Object.keys(messages.byMessageId).length : 0;
    result.usage = addUsage(result.usage, usage);
    result.sessions++;
  }
  return result;
}
function resolveStorageDir(env = process.env) {
  const override = env.OPENCHAMBER_DCP_STORAGE_DIR?.trim();
  if (override)
    return override;
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "storage", "plugin", "dcp");
}
var SESSION_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

class StatsStore {
  dir;
  cache = new Map;
  allTimeInFlight = null;
  constructor(dir) {
    this.dir = dir;
  }
  get storageDir() {
    return this.dir;
  }
  async getStats(sessionId) {
    const generatedAt = Date.now();
    if (!await this.dirExists()) {
      return {
        ok: true,
        storageDir: this.dir,
        generatedAt,
        reason: "storage-missing",
        session: null,
        allTime: null
      };
    }
    const session = sessionId ? await this.readSession(sessionId) : null;
    const allTime = await this.getAllTime();
    return { ok: true, storageDir: this.dir, generatedAt, session, allTime };
  }
  async readSession(sessionId) {
    if (!SESSION_ID_PATTERN.test(sessionId))
      return null;
    const state = await this.readStateCached(path.join(this.dir, `${sessionId}.json`));
    return buildSessionReport(state, sessionId);
  }
  async getAllTime() {
    if (this.allTimeInFlight)
      return this.allTimeInFlight;
    this.allTimeInFlight = this.scanAllTime().finally(() => {
      this.allTimeInFlight = null;
    });
    return this.allTimeInFlight;
  }
  async scanAllTime() {
    let files;
    try {
      files = await fs.readdir(this.dir);
    } catch {
      return aggregateAllTime([]);
    }
    const jsonFiles = files.filter((file) => file.endsWith(".json"));
    const live = new Set;
    const states = [];
    for (const file of jsonFiles) {
      const filePath = path.join(this.dir, file);
      live.add(filePath);
      states.push(await this.readStateCached(filePath));
    }
    for (const key of this.cache.keys()) {
      if (!live.has(key))
        this.cache.delete(key);
    }
    return aggregateAllTime(states);
  }
  async readStateCached(filePath) {
    let stat2;
    try {
      stat2 = await fs.stat(filePath);
    } catch {
      this.cache.delete(filePath);
      return null;
    }
    const hit = this.cache.get(filePath);
    if (hit && hit.mtimeMs === stat2.mtimeMs && hit.size === stat2.size) {
      return hit.state;
    }
    let state = null;
    try {
      state = JSON.parse(await fs.readFile(filePath, "utf-8"));
    } catch {
      state = null;
    }
    this.cache.set(filePath, { mtimeMs: stat2.mtimeMs, size: stat2.size, state });
    return state;
  }
  async dirExists() {
    try {
      const stat2 = await fs.stat(this.dir);
      return stat2.isDirectory();
    } catch {
      return false;
    }
  }
}

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT || process.env.OPENCHAMBER_AGENT_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN || process.env.OPENCHAMBER_AGENT_TOKEN || "";
if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error("[dcp-stats] OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var store = new StatsStore(resolveStorageDir());
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
var server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/stats") {
      const session = (url.searchParams.get("session") ?? "").trim() || null;
      sendJson(res, 200, await store.getStats(session));
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`[dcp-stats] listening on 127.0.0.1:${port} (storage: ${store.storageDir})`);
});
