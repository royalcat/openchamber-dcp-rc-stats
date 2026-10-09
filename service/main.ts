/**
 * DCP Stats — local service.
 *
 * Runs as the extension's local process (manifest `contributes.service`) on
 * 127.0.0.1, reachable only through the OpenChamber host proxy. It reads the
 * DCP RC state files and answers the panel's `serviceRequest` calls.
 *
 * Endpoints (bearer token required on every request, including `/health`):
 *   GET /health            → { ok: true }
 *   GET /stats?session=ID  → StatsPayload (see service/stats.ts)
 */

import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { StatsStore, resolveStorageDir } from "./stats"

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT || process.env.OPENCHAMBER_AGENT_PORT)
const token = process.env.OPENCHAMBER_SERVICE_TOKEN || process.env.OPENCHAMBER_AGENT_TOKEN || ""

if (!Number.isInteger(port) || port <= 0 || !token) {
    console.error("[dcp-stats] OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required")
    process.exit(1)
}

const store = new StatsStore(resolveStorageDir())

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
            sendJson(res, 200, await store.getStats(session))
            return
        }

        sendJson(res, 404, { error: "not found" })
    } catch (error) {
        sendJson(res, 500, {
            error: error instanceof Error ? error.message : String(error),
        })
    }
})

server.listen(port, "127.0.0.1", () => {
    console.log(`[dcp-stats] listening on 127.0.0.1:${port} (storage: ${store.storageDir})`)
})
