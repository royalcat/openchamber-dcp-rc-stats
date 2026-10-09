/**
 * DCP RC stats aggregation.
 *
 * Reads the state files the DCP RC plugin persists per session
 * (`<data>/opencode/storage/plugin/dcp/{sessionId}.json`) and reproduces the
 * numbers of `/dcp stats`: the session report and all-time totals.
 *
 * Parity rules mirror `@royalcat/opencode-dcp-rc`:
 *  - `lib/commands/stats.ts` (`buildStatsReport`)
 *  - `lib/state/persistence.ts` (`loadAllSessionStats`)
 *  - `lib/compress/usage.ts` (`normalizeCompressionUsageTotals`)
 *
 * The persisted file shapes are treated as untrusted JSON: every field is
 * validated before use and malformed files are skipped, never thrown.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

// ------------------------------------------------------------------ types

/** Aggregated usage of the hidden compression (summary) requests. */
export interface CompressionUsage {
    calls: number
    providerCalls: number
    estimatedCalls: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
}

export interface ActiveBlock {
    blockId: number
    topic: string
    compressedTokens: number
    summaryTokens: number
    durationMs: number
    toolCount: number
    messageCount: number
    createdAt: number
}

export interface SessionReport {
    id: string
    found: true
    sessionName: string | null
    lastUpdated: string | null
    tokensIn: number
    tokensOut: number
    durationMs: number
    messages: number
    tools: number
    usage: CompressionUsage
    blocks: ActiveBlock[]
}

export interface AllTime {
    tokens: number
    tools: number
    messages: number
    sessions: number
    usage: CompressionUsage
}

export interface StatsPayload {
    ok: true
    storageDir: string
    generatedAt: number
    reason?: "storage-missing"
    session: SessionReport | null
    allTime: AllTime | null
}

// ------------------------------------------------------------- value guards

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `toCount` from the plugin: finite non-negative numbers, rounded. */
function toCount(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return 0
    }
    return Math.round(value)
}

function toInteger(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        return fallback
    }
    return value
}

function toStringOr(value: unknown, fallback: string): string {
    return typeof value === "string" ? value : fallback
}

function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is string => typeof entry === "string")
}

export function emptyUsage(): CompressionUsage {
    return {
        calls: 0,
        providerCalls: 0,
        estimatedCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
    }
}

/** `normalizeCompressionUsageTotals` from the plugin. */
export function normalizeUsage(value: unknown): CompressionUsage {
    if (!isRecord(value)) return emptyUsage()
    return {
        calls: toCount(value.calls),
        providerCalls: toCount(value.providerCalls),
        estimatedCalls: toCount(value.estimatedCalls),
        inputTokens: toCount(value.inputTokens),
        outputTokens: toCount(value.outputTokens),
        cacheReadTokens: toCount(value.cacheReadTokens),
        cacheWriteTokens: toCount(value.cacheWriteTokens),
        reasoningTokens: toCount(value.reasoningTokens),
    }
}

export function addUsage(a: CompressionUsage, b: CompressionUsage): CompressionUsage {
    return {
        calls: a.calls + b.calls,
        providerCalls: a.providerCalls + b.providerCalls,
        estimatedCalls: a.estimatedCalls + b.estimatedCalls,
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
        reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    }
}

// --------------------------------------------------------------- aggregation

interface ActiveBlockEntry extends ActiveBlock {
    toolIds: string[]
}

function collectActiveBlocks(messages: Record<string, unknown>): ActiveBlockEntry[] {
    const blocksById = isRecord(messages.blocksById) ? messages.blocksById : {}
    const entries: ActiveBlockEntry[] = []
    for (const [key, value] of Object.entries(blocksById)) {
        if (!isRecord(value) || value.active !== true) continue
        const fallbackId = Number.parseInt(key, 10)
        const topic =
            typeof value.topic === "string" && value.topic.length > 0
                ? value.topic
                : toStringOr(value.batchTopic, "")
        entries.push({
            blockId: toInteger(value.blockId, Number.isInteger(fallbackId) ? fallbackId : 0),
            topic,
            compressedTokens: toCount(value.compressedTokens),
            summaryTokens: toCount(value.summaryTokens),
            durationMs: toCount(value.durationMs),
            toolCount: toStringArray(value.effectiveToolIds).length,
            messageCount: toStringArray(value.effectiveMessageIds).length,
            createdAt: toCount(value.createdAt),
            toolIds: toStringArray(value.effectiveToolIds),
        })
    }
    entries.sort((a, b) => a.blockId - b.blockId)
    return entries
}

function countPrunedMessages(messages: Record<string, unknown>): number {
    if (!isRecord(messages.byMessageId)) return 0
    let count = 0
    for (const entry of Object.values(messages.byMessageId)) {
        if (isRecord(entry) && Array.isArray(entry.activeBlockIds) && entry.activeBlockIds.length > 0) {
            count++
        }
    }
    return count
}

/** `buildStatsReport` for one session state. `null` when the state is unusable. */
export function buildSessionReport(state: unknown, sessionId: string): SessionReport | null {
    if (!isRecord(state)) return null
    const prune = isRecord(state.prune) ? state.prune : null
    const stats = isRecord(state.stats) ? state.stats : null
    if (!prune || !stats) return null
    // `loadSessionState` rejects files without these two records.
    if (!isRecord(prune.tools) || !isRecord(prune.messages)) return null

    const messages = prune.messages
    const blocks = collectActiveBlocks(messages)

    const tools = new Set<string>()
    if (isRecord(prune.tools)) {
        for (const toolId of Object.keys(prune.tools)) tools.add(toolId)
    }
    for (const block of blocks) {
        for (const toolId of block.toolIds) tools.add(toolId)
    }

    const tokensOut = blocks.reduce((total, block) => total + block.summaryTokens, 0)
    const durationMs = blocks.reduce((total, block) => total + block.durationMs, 0)

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
        blocks: blocks.map(({ toolIds: _toolIds, ...block }) => block),
    }
}

/** `loadAllSessionStats` over a set of parsed states. */
export function aggregateAllTime(states: Iterable<unknown>): AllTime {
    const result: AllTime = {
        tokens: 0,
        tools: 0,
        messages: 0,
        sessions: 0,
        usage: emptyUsage(),
    }

    for (const state of states) {
        if (!isRecord(state)) continue
        const prune = isRecord(state.prune) ? state.prune : null
        if (!prune) continue
        const stats = isRecord(state.stats) ? state.stats : null
        const usage = normalizeUsage(stats?.compressionUsage)
        const tokens = toCount(stats?.totalPruneTokens)
        if (tokens === 0 && usage.calls === 0) continue

        result.tokens += tokens
        result.tools += isRecord(prune.tools) ? Object.keys(prune.tools).length : 0
        const messages = isRecord(prune.messages) ? prune.messages : {}
        result.messages += isRecord(messages.byMessageId)
            ? Object.keys(messages.byMessageId).length
            : 0
        result.usage = addUsage(result.usage, usage)
        result.sessions++
    }

    return result
}

// -------------------------------------------------------------- storage dir

export function resolveStorageDir(env: NodeJS.ProcessEnv = process.env): string {
    const override = env.OPENCHAMBER_DCP_STORAGE_DIR?.trim()
    if (override) return override
    const dataHome =
        env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share")
    return path.join(dataHome, "opencode", "storage", "plugin", "dcp")
}

// ------------------------------------------------------------------- store

interface CacheEntry {
    mtimeMs: number
    size: number
    state: unknown
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

export class StatsStore {
    private readonly dir: string
    private readonly cache = new Map<string, CacheEntry>()
    private allTimeInFlight: Promise<AllTime> | null = null

    constructor(dir: string) {
        this.dir = dir
    }

    get storageDir(): string {
        return this.dir
    }

    async getStats(sessionId: string | null): Promise<StatsPayload> {
        const generatedAt = Date.now()
        if (!(await this.dirExists())) {
            return {
                ok: true,
                storageDir: this.dir,
                generatedAt,
                reason: "storage-missing",
                session: null,
                allTime: null,
            }
        }

        const session = sessionId ? await this.readSession(sessionId) : null
        const allTime = await this.getAllTime()
        return { ok: true, storageDir: this.dir, generatedAt, session, allTime }
    }

    async readSession(sessionId: string): Promise<SessionReport | null> {
        if (!SESSION_ID_PATTERN.test(sessionId)) return null
        const state = await this.readStateCached(path.join(this.dir, `${sessionId}.json`))
        return buildSessionReport(state, sessionId)
    }

    async getAllTime(): Promise<AllTime> {
        if (this.allTimeInFlight) return this.allTimeInFlight
        this.allTimeInFlight = this.scanAllTime().finally(() => {
            this.allTimeInFlight = null
        })
        return this.allTimeInFlight
    }

    private async scanAllTime(): Promise<AllTime> {
        let files: string[]
        try {
            files = await fs.readdir(this.dir)
        } catch {
            return aggregateAllTime([])
        }

        const jsonFiles = files.filter((file) => file.endsWith(".json"))
        const live = new Set<string>()
        const states: unknown[] = []
        for (const file of jsonFiles) {
            const filePath = path.join(this.dir, file)
            live.add(filePath)
            states.push(await this.readStateCached(filePath))
        }
        for (const key of this.cache.keys()) {
            if (!live.has(key)) this.cache.delete(key)
        }
        return aggregateAllTime(states)
    }

    private async readStateCached(filePath: string): Promise<unknown> {
        let stat: Awaited<ReturnType<typeof fs.stat>>
        try {
            stat = await fs.stat(filePath)
        } catch {
            this.cache.delete(filePath)
            return null
        }

        const hit = this.cache.get(filePath)
        if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
            return hit.state
        }

        let state: unknown = null
        try {
            state = JSON.parse(await fs.readFile(filePath, "utf-8"))
        } catch {
            state = null
        }
        this.cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, state })
        return state
    }

    private async dirExists(): Promise<boolean> {
        try {
            const stat = await fs.stat(this.dir)
            return stat.isDirectory()
        } catch {
            return false
        }
    }
}
