/**
 * DCP Stats — local service.
 *
 * Runs as the extension's local process (manifest `contributes.service`) on
 * 127.0.0.1, reachable only through the OpenChamber host proxy. It reads the
 * DCP RC state files and answers the panel's `serviceRequest` calls.
 *
 * Endpoints (bearer token required on every request, including `/health`):
 *   GET  /health                 → { ok: true }
 *   GET  /stats?session=ID&directory=PATH → StatsPayload (see service/stats.ts)
 *   POST /project-mode           → { ok: true, project: ProjectStatus }
 */

import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { ProjectConfigError, ProjectConfigStore } from "./config"
import { StatsStore, resolveStorageDir } from "./stats"

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT || process.env.OPENCHAMBER_AGENT_PORT)
const token = process.env.OPENCHAMBER_SERVICE_TOKEN || process.env.OPENCHAMBER_AGENT_TOKEN || ""

if (!Number.isInteger(port) || port <= 0 || !token) {
    console.error("[dcp-stats] OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required")
    process.exit(1)
}

const store = new StatsStore(resolveStorageDir())
const projects = new ProjectConfigStore()

class RequestError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message)
        this.name = "RequestError"
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > 16 * 1024) throw new RequestError(413, "request body is too large")
        chunks.push(buffer)
    }
    if (size === 0) throw new RequestError(400, "request body is required")
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf-8"))
    } catch {
        throw new RequestError(400, "request body must be JSON")
    }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
    })
    res.end(payload)
}

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
        sendJson(res, 401, { error: "unauthorized" })
        return
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1")

    try {
        if (req.method === "GET" && url.pathname === "/health") {
            sendJson(res, 200, { ok: true })
            return
        }

        if (req.method === "GET" && url.pathname === "/stats") {
            const session = (url.searchParams.get("session") ?? "").trim() || null
            const directory = (url.searchParams.get("directory") ?? "").trim() || null
            let project = null
            if (directory) {
                try {
                    project = await projects.getStatus(directory)
                } catch (error) {
                    if (!(error instanceof ProjectConfigError)) throw error
                }
            }
            sendJson(res, 200, { ...(await store.getStats(session)), project })
            return
        }

        if (req.method === "POST" && url.pathname === "/project-mode") {
            const body = await readJsonBody(req)
            if (!isRecord(body)) {
                throw new RequestError(400, "request body must be an object")
            }
            const directory = typeof body.directory === "string" ? body.directory : ""
            const mode = body.mode
            if (mode !== "automatic" && mode !== "passive") {
                throw new RequestError(400, "mode must be automatic or passive")
            }
            const project = await projects.setMode(directory, mode)
            sendJson(res, 200, { ok: true, project })
            return
        }

        sendJson(res, 404, { error: "not found" })
    } catch (error) {
        if (error instanceof RequestError) {
            sendJson(res, error.status, { error: error.message })
            return
        }
        if (error instanceof ProjectConfigError) {
            const status =
                error.code === "invalid-directory" || error.code === "invalid-mode" ? 400 : 409
            sendJson(res, status, { error: error.message })
            return
        }
        sendJson(res, 500, {
            error: error instanceof Error ? error.message : String(error),
        })
    }
})

server.listen(port, "127.0.0.1", () => {
    console.log(`[dcp-stats] listening on 127.0.0.1:${port} (storage: ${store.storageDir})`)
})
