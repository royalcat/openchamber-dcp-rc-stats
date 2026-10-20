/**
 * Smoke test for the built service.
 *
 * Starts `service/main.js` against temporary storage and project directories,
 * then checks the auth gate, `/health`, `/stats` and `/project-mode`.
 *
 * Run after `bun run build`:  node scripts/smoke.mjs
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import { createServer } from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const serviceEntry = path.join(root, "service", "main.js")

async function freePort() {
    const server = createServer()
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address()
    await new Promise((resolve) => server.close(resolve))
    return port
}

const sessionId = "ses_smoke"
const fixture = {
    manualMode: false,
    prune: {
        tools: { t1: 1 },
        messages: {
            byMessageId: {
                m1: { tokenCount: 1, allBlockIds: [1], activeBlockIds: [1] },
            },
            blocksById: {
                "1": {
                    blockId: 1,
                    runId: 1,
                    active: true,
                    deactivatedByUser: false,
                    compressedTokens: 5000,
                    summaryTokens: 400,
                    durationMs: 1200,
                    topic: "smoke",
                    startId: "m0001",
                    endId: "m0002",
                    anchorMessageId: "m0003",
                    compressMessageId: "m0004",
                    includedBlockIds: [],
                    consumedBlockIds: [],
                    parentBlockIds: [],
                    directMessageIds: [],
                    directToolIds: [],
                    effectiveMessageIds: ["m1"],
                    effectiveToolIds: ["t2"],
                    createdAt: Date.now(),
                    summary: "s",
                },
            },
            activeBlockIds: [1],
            activeByAnchorMessageId: {},
            nextBlockId: 2,
            nextRunId: 1,
        },
    },
    nudges: { contextLimitAnchors: [], turnNudgeAnchors: [], iterationNudgeAnchors: [] },
    stats: {
        pruneTokenCounter: 0,
        totalPruneTokens: 1234,
        compressionUsage: {
            calls: 1,
            providerCalls: 1,
            estimatedCalls: 0,
            inputTokens: 100,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
        },
    },
    lastUpdated: new Date().toISOString(),
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dcp-stats-smoke-"))
await fs.writeFile(path.join(dir, `${sessionId}.json`), JSON.stringify(fixture))
const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "dcp-stats-project-"))
const globalConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "dcp-stats-global-"))

const token = "smoke-token"
const port = await freePort()
const child = spawn(process.execPath, [serviceEntry], {
    env: {
        ...process.env,
        OPENCHAMBER_SERVICE_PORT: String(port),
        OPENCHAMBER_SERVICE_TOKEN: token,
        OPENCHAMBER_DCP_STORAGE_DIR: dir,
        OPENCHAMBER_DCP_GLOBAL_CONFIG_DIR: globalConfigDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
})

let stderr = ""
child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
})

const base = `http://127.0.0.1:${port}`

async function waitForHealth() {
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            const response = await fetch(`${base}/health`, {
                headers: { authorization: `Bearer ${token}` },
            })
            if (response.ok) return
        } catch {
            // not up yet
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`service did not become healthy; stderr: ${stderr}`)
}

try {
    await waitForHealth()

    const unauthorized = await fetch(`${base}/health`)
    assert.equal(unauthorized.status, 401)

    const response = await fetch(`${base}/stats?session=${sessionId}`, {
        headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.storageDir, dir)
    assert.equal(body.session.id, sessionId)
    assert.equal(body.session.tokensIn, 1234)
    assert.equal(body.session.tokensOut, 400)
    assert.equal(body.session.tools, 2)
    assert.equal(body.session.messages, 1)
    assert.equal(body.session.blocks.length, 1)
    assert.equal(body.session.blocks[0].topic, "smoke")
    assert.equal(body.allTime.tokens, 1234)
    assert.equal(body.allTime.sessions, 1)
    assert.equal(body.allTime.usage.calls, 1)

    const projectStats = await fetch(
        `${base}/stats?session=${sessionId}&directory=${encodeURIComponent(projectDir)}`,
        { headers: { authorization: `Bearer ${token}` } },
    )
    assert.equal(projectStats.status, 200)
    const projectBody = await projectStats.json()
    assert.equal(projectBody.project.mode, "automatic")
    assert.equal(projectBody.project.source, "default")

    const toggle = await fetch(`${base}/project-mode`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({ directory: projectDir, mode: "passive" }),
    })
    assert.equal(toggle.status, 200)
    const toggled = await toggle.json()
    assert.equal(toggled.ok, true)
    assert.equal(toggled.project.mode, "passive")
    assert.equal(toggled.project.projectConfigPath, path.join(projectDir, ".opencode", "dcp-rc.jsonc"))

    const configText = await fs.readFile(
        path.join(projectDir, ".opencode", "dcp-rc.jsonc"),
        "utf-8",
    )
    assert.match(configText, /"manualMode"/)
    assert.match(configText, /"allowCompressTool": true/)

    const refreshed = await fetch(
        `${base}/stats?session=${sessionId}&directory=${encodeURIComponent(projectDir)}`,
        { headers: { authorization: `Bearer ${token}` } },
    )
    assert.equal(refreshed.status, 200)
    assert.equal((await refreshed.json()).project.mode, "passive")

    const badMode = await fetch(`${base}/project-mode`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({ directory: projectDir, mode: "off" }),
    })
    assert.equal(badMode.status, 400)

    console.log("smoke ok: health, auth gate, stats, project status and project-mode toggle")
} finally {
    child.kill()
    await Promise.all([
        fs.rm(dir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
        fs.rm(globalConfigDir, { recursive: true, force: true }),
    ])
}
