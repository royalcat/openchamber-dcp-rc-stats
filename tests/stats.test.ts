import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
    StatsStore,
    aggregateAllTime,
    buildSessionReport,
    emptyUsage,
    normalizeUsage,
    resolveStorageDir,
} from "../service/stats"

// ------------------------------------------------------------------ fixtures

function usage(overrides: Record<string, number> = {}) {
    return { ...emptyUsage(), ...overrides }
}

function block(overrides: Record<string, unknown> = {}) {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 100,
        durationMs: 500,
        topic: "topic",
        startId: "m0001",
        endId: "m0004",
        anchorMessageId: "m0005",
        compressMessageId: "m0006",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["m0001", "m0002"],
        effectiveToolIds: ["t1", "t2"],
        createdAt: 1_700_000_000_000,
        summary: "summary",
        ...overrides,
    }
}

function state(overrides: Record<string, unknown> = {}) {
    return {
        manualMode: false,
        prune: {
            tools: {},
            messages: {
                byMessageId: {},
                blocksById: {},
                activeBlockIds: [],
                activeByAnchorMessageId: {},
                nextBlockId: 1,
                nextRunId: 1,
            },
        },
        nudges: {
            contextLimitAnchors: [],
            turnNudgeAnchors: [],
            iterationNudgeAnchors: [],
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
            compressionUsage: emptyUsage(),
        },
        lastUpdated: "2026-10-01T00:00:00.000Z",
        ...overrides,
    }
}

// ------------------------------------------------------------- normalization

test("normalizeUsage mirrors normalizeCompressionUsageTotals", () => {
    assert.deepEqual(normalizeUsage(null), emptyUsage())
    assert.deepEqual(normalizeUsage("nope"), emptyUsage())

    const result = normalizeUsage({
        calls: 1.6,
        providerCalls: 2,
        estimatedCalls: -1,
        inputTokens: -5,
        outputTokens: "x",
        cacheReadTokens: Number.NaN,
        cacheWriteTokens: 10.4,
        reasoningTokens: 0,
    })
    assert.equal(result.calls, 2)
    assert.equal(result.providerCalls, 2)
    assert.equal(result.estimatedCalls, 0)
    assert.equal(result.inputTokens, 0)
    assert.equal(result.outputTokens, 0)
    assert.equal(result.cacheReadTokens, 0)
    assert.equal(result.cacheWriteTokens, 10)
})

// ---------------------------------------------------------- session reports

test("buildSessionReport mirrors buildStatsReport", () => {
    const report = buildSessionReport(
        state({
            sessionName: "my session",
            prune: {
                tools: { t2: 1, t3: 2 },
                messages: {
                    byMessageId: {
                        m0001: { tokenCount: 10, allBlockIds: [1], activeBlockIds: [1] },
                        m0002: { tokenCount: 10, allBlockIds: [], activeBlockIds: [] },
                        m0003: { tokenCount: 10, allBlockIds: [1, 2], activeBlockIds: [1, 2] },
                    },
                    blocksById: {
                        "1": block({
                            blockId: 1,
                            summaryTokens: 100,
                            durationMs: 500,
                            effectiveToolIds: ["t1", "t2"],
                        }),
                        "2": block({
                            blockId: 2,
                            active: false,
                            summaryTokens: 999,
                            durationMs: 9999,
                            effectiveToolIds: ["t9"],
                        }),
                    },
                    activeBlockIds: [1],
                    activeByAnchorMessageId: {},
                    nextBlockId: 3,
                    nextRunId: 1,
                },
            },
            stats: {
                pruneTokenCounter: 0,
                totalPruneTokens: 5000,
                compressionUsage: usage({
                    calls: 2,
                    providerCalls: 1,
                    estimatedCalls: 1,
                    inputTokens: 100,
                    outputTokens: 10,
                }),
            },
        }),
        "ses_test",
    )

    assert.ok(report)
    assert.equal(report.id, "ses_test")
    assert.equal(report.sessionName, "my session")
    assert.equal(report.lastUpdated, "2026-10-01T00:00:00.000Z")
    assert.equal(report.tokensIn, 5000)
    assert.equal(report.tokensOut, 100) // only the active block
    assert.equal(report.durationMs, 500) // only the active block
    assert.equal(report.messages, 2) // m0001 and m0003
    assert.equal(report.tools, 3) // t2, t3 from prune.tools + t1 from the block
    assert.equal(report.usage.calls, 2)

    assert.equal(report.blocks.length, 1)
    assert.equal(report.blocks[0].blockId, 1)
    assert.equal(report.blocks[0].toolCount, 2)
    assert.equal(report.blocks[0].messageCount, 2)
    assert.equal("toolIds" in report.blocks[0], false)
})

test("buildSessionReport rejects unusable states", () => {
    assert.equal(buildSessionReport(null, "ses_x"), null)
    assert.equal(buildSessionReport("junk", "ses_x"), null)
    assert.equal(buildSessionReport({}, "ses_x"), null)
    assert.equal(buildSessionReport({ prune: {}, stats: {} }, "ses_x"), null)
    assert.equal(
        buildSessionReport({ prune: { tools: {} }, stats: {} }, "ses_x"),
        null,
    )
})

test("buildSessionReport sorts blocks by id and tolerates odd fields", () => {
    const report = buildSessionReport(
        state({
            prune: {
                tools: {},
                messages: {
                    byMessageId: {},
                    blocksById: {
                        "7": block({ blockId: 7, topic: "", batchTopic: "fallback", compressedTokens: -1, summaryTokens: "x" }),
                        "3": block({ blockId: 3, active: "yes" }),
                    },
                    activeBlockIds: [],
                    activeByAnchorMessageId: {},
                    nextBlockId: 8,
                    nextRunId: 1,
                },
            },
            stats: { pruneTokenCounter: 0, totalPruneTokens: 0, compressionUsage: emptyUsage() },
        }),
        "ses_x",
    )
    assert.ok(report)
    assert.equal(report.blocks.length, 1)
    assert.equal(report.blocks[0].blockId, 7)
    assert.equal(report.blocks[0].topic, "fallback")
    assert.equal(report.blocks[0].compressedTokens, 0)
    assert.equal(report.blocks[0].summaryTokens, 0)
})

// ---------------------------------------------------------------- all-time

test("aggregateAllTime mirrors loadAllSessionStats", () => {
    const withStats = state({
        prune: {
            tools: { t1: 1 },
            messages: {
                byMessageId: { m1: {}, m2: {} },
                blocksById: {},
                activeBlockIds: [],
                activeByAnchorMessageId: {},
                nextBlockId: 1,
                nextRunId: 1,
            },
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 1000,
            compressionUsage: usage({ calls: 1, providerCalls: 1, inputTokens: 50, outputTokens: 5 }),
        },
    })
    const usageOnly = state({
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
            compressionUsage: usage({ calls: 2, estimatedCalls: 2, inputTokens: 20, outputTokens: 2 }),
        },
    })
    const empty = state()
    const noPrune = { stats: { totalPruneTokens: 999 } }

    const result = aggregateAllTime([withStats, usageOnly, empty, noPrune, null, undefined, "junk"])
    assert.equal(result.tokens, 1000)
    assert.equal(result.tools, 1)
    assert.equal(result.messages, 2)
    assert.equal(result.sessions, 2)
    assert.equal(result.usage.calls, 3)
    assert.equal(result.usage.providerCalls, 1)
    assert.equal(result.usage.estimatedCalls, 2)
    assert.equal(result.usage.inputTokens, 70)
    assert.equal(result.usage.outputTokens, 7)
})

// ------------------------------------------------------------------- store

async function makeTempDir(t: { after: (fn: () => void | Promise<void>) => void }): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dcp-stats-"))
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    return dir
}

test("StatsStore reads sessions and all-time totals", async (t) => {
    const dir = await makeTempDir(t)
    const sessionId = "ses_abc"
    await fs.writeFile(
        path.join(dir, `${sessionId}.json`),
        JSON.stringify(
            state({
                stats: {
                    pruneTokenCounter: 0,
                    totalPruneTokens: 42,
                    compressionUsage: usage({ calls: 1, inputTokens: 7, outputTokens: 1 }),
                },
            }),
        ),
    )
    await fs.writeFile(path.join(dir, "junk.json"), "{not json")

    const store = new StatsStore(dir)
    const result = await store.getStats(sessionId)
    assert.equal(result.ok, true)
    assert.equal(result.reason, undefined)
    assert.equal(result.session?.tokensIn, 42)
    assert.equal(result.allTime?.tokens, 42)
    assert.equal(result.allTime?.sessions, 1)
    assert.equal(result.allTime?.usage.calls, 1)
})

test("StatsStore invalidates its cache when files change or disappear", async (t) => {
    const dir = await makeTempDir(t)
    const sessionId = "ses_cache"
    const file = path.join(dir, `${sessionId}.json`)

    await fs.writeFile(file, JSON.stringify(state({ stats: { pruneTokenCounter: 0, totalPruneTokens: 42, compressionUsage: emptyUsage() } })))
    const store = new StatsStore(dir)
    assert.equal((await store.getStats(sessionId)).session?.tokensIn, 42)

    await fs.writeFile(file, JSON.stringify(state({ stats: { pruneTokenCounter: 0, totalPruneTokens: 84, compressionUsage: emptyUsage() } })))
    assert.equal((await store.getStats(sessionId)).session?.tokensIn, 84)

    await fs.rm(file)
    const afterDelete = await store.getStats(sessionId)
    assert.equal(afterDelete.session, null)
    assert.equal(afterDelete.allTime?.sessions, 0)
})

test("StatsStore reports a missing storage directory", async () => {
    const dir = path.join(os.tmpdir(), `dcp-stats-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const store = new StatsStore(dir)
    const result = await store.getStats("ses_x")
    assert.equal(result.reason, "storage-missing")
    assert.equal(result.session, null)
    assert.equal(result.allTime, null)
    assert.equal(result.storageDir, dir)
})

test("StatsStore rejects unsafe session ids", async (t) => {
    const dir = await makeTempDir(t)
    const store = new StatsStore(dir)
    assert.equal(await store.readSession("../evil"), null)
    assert.equal(await store.readSession("a/b"), null)
    assert.equal(await store.readSession(""), null)
})

// -------------------------------------------------------------- storage dir

test("resolveStorageDir honours the override, XDG_DATA_HOME and the default", () => {
    assert.equal(
        resolveStorageDir({ OPENCHAMBER_DCP_STORAGE_DIR: "/tmp/custom" } as NodeJS.ProcessEnv),
        "/tmp/custom",
    )
    assert.equal(
        resolveStorageDir({ XDG_DATA_HOME: "/tmp/data" } as NodeJS.ProcessEnv),
        path.join("/tmp/data", "opencode", "storage", "plugin", "dcp"),
    )
    assert.equal(
        resolveStorageDir({} as NodeJS.ProcessEnv),
        path.join(os.homedir(), ".local", "share", "opencode", "storage", "plugin", "dcp"),
    )
})
