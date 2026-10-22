/**
 * DCP Stats — OpenChamber extension panel.
 *
 * One page serves two surfaces:
 *  - `panel`: the rail side panel with the full report.
 *  - `status`: the compact section in the chat's Work Status panel.
 *
 * The page is a thin view. The extension's local service reads the DCP RC
 * state files and returns the numbers; this file only renders them.
 */

import { connectHost, HostRequestError } from "@openchamber/sdk"
import type { HostReadyContext, SessionSnapshot } from "@openchamber/sdk"
import { applyHostReady, mountBadge, mountBanner, mountButton } from "@openchamber/sdk/ui"
import type { BadgeHandle, BannerHandle, ButtonHandle } from "@openchamber/sdk/ui"
import type { ProjectStatus } from "../service/config"
import type { ActiveBlock, AllTime, SessionReport, StatsPayload } from "../service/stats"

const POLL_MS = 4000

const host = connectHost()
const rootElement = document.querySelector<HTMLElement>("#root")
if (!rootElement) {
    throw new Error("Missing #root")
}
const root = rootElement

type Notice = {
    tone: "info" | "success" | "warning" | "error"
    title: string
    body?: string
}

type MetricRow = {
    label: string
    value: string
    tone?: "success"
}

let mounted = false
let surface: "panel" | "status" = "panel"
let sessionId: string | null = null
let sessionTitle = ""
let projectDirectory: string | null = null
let directoryWired = false
let payload: StatsPayload | null = null
let notice: Notice | null = null
let projectNotice: string | null = null
let projectActionError: string | null = null
let projectBusy = false
let pollTimer: number | null = null
let fetchSeq = 0
let lastStatusHeight = -1

let refs: {
    subtitle: HTMLElement
    notice: HTMLElement
    projectSection: HTMLElement
    projectName: HTMLElement
    projectDescription: HTMLElement
    projectHint: HTMLElement
    projectSession: HTMLElement
    projectNotice: HTMLElement
    projectError: HTMLElement
    projectAction: ButtonHandle
    projectBadge: BadgeHandle
    sessionMeta: HTMLElement
    sessionMetrics: HTMLElement
    blocks: HTMLElement
    sessionHint: HTMLElement
    allTimeMetrics: HTMLElement
    allTimeHint: HTMLElement
    refresh: ButtonHandle
} | null = null

let statusRefs: {
    saved: HTMLElement
    ratio: HTMLElement
    sub: HTMLElement
} | null = null

let noticeHandle: BannerHandle | null = null

// ---------------------------------------------------------------- dom helpers

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
}

// -------------------------------------------------------------------- mounting

function mountPanel(): void {
    const panel = el("div", "dcp dcp-panel")

    const header = el("div", "dcp-header")
    const heading = el("div", "dcp-heading")
    const title = el("div", "dcp-title", "DCP Stats")
    const subtitle = el("div", "dcp-subtitle", "")
    heading.append(title, subtitle)
    const actions = el("div", "dcp-actions")
    const refresh = mountButton(actions, {
        label: "Refresh",
        variant: "ghost",
        size: "xs",
        onClick: () => void refreshStats(),
    })
    header.append(heading, actions)

    const noticeEl = el("div", "dcp-notice")
    const body = el("div", "dcp-body")

    const projectSection = el("section", "dcp-section dcp-project")
    const projectHeader = el("div", "dcp-section-header")
    const projectBadgeSlot = el("span", "dcp-project-badge")
    projectHeader.append(el("span", undefined, "Project"), projectBadgeSlot)
    const projectCard = el("div", "dcp-project-card")
    const projectName = el("div", "dcp-project-name", "")
    const projectDescription = el("div", "dcp-project-desc", "")
    const projectHint = el("div", "dcp-project-hint", "")
    const projectSessionEl = el("div", "dcp-project-session")
    const projectNoticeEl = el("div", "dcp-project-notice")
    const projectErrorEl = el("div", "dcp-project-error")
    const projectActions = el("div", "dcp-project-actions")
    const projectAction = mountButton(projectActions, {
        label: "Make passive",
        variant: "outline",
        size: "xs",
        onClick: () => void toggleProjectMode(),
    })
    projectCard.append(
        projectName,
        projectDescription,
        projectHint,
        projectSessionEl,
        projectNoticeEl,
        projectErrorEl,
        projectActions,
    )
    projectSection.hidden = true
    projectSection.append(projectHeader, projectCard)
    const projectBadge = mountBadge(projectBadgeSlot, {
        label: "Free",
        tone: "success",
    })

    const sessionSection = el("section", "dcp-section")
    const sessionHeader = el("div", "dcp-section-header")
    const sessionMeta = el("span", "dcp-section-meta", "")
    sessionHeader.append(el("span", undefined, "Session"), sessionMeta)
    const sessionMetrics = el("div", "dcp-metrics")
    const blocks = el("div", "dcp-blocks")
    const sessionHint = el("div", "dcp-hint")
    sessionSection.append(sessionHeader, sessionMetrics, blocks, sessionHint)

    const allTimeSection = el("section", "dcp-section")
    const allTimeHeader = el("div", "dcp-section-header")
    allTimeHeader.append(el("span", undefined, "All-time"))
    const allTimeMetrics = el("div", "dcp-metrics")
    const allTimeHint = el("div", "dcp-hint")
    allTimeSection.append(allTimeHeader, allTimeMetrics, allTimeHint)

    body.append(projectSection, sessionSection, allTimeSection)
    panel.append(header, noticeEl, body)
    root.replaceChildren(panel)

    refs = {
        subtitle,
        notice: noticeEl,
        projectSection,
        projectName,
        projectDescription,
        projectHint,
        projectSession: projectSessionEl,
        projectNotice: projectNoticeEl,
        projectError: projectErrorEl,
        projectAction,
        projectBadge,
        sessionMeta,
        sessionMetrics,
        blocks,
        sessionHint,
        allTimeMetrics,
        allTimeHint,
        refresh,
    }
}

function mountStatus(): void {
    const status = el("div", "dcp dcp-status")
    const main = el("div", "dcp-status-main")
    const saved = el("span", "dcp-status-saved", "DCP")
    const ratio = el("span", "dcp-status-ratio")
    ratio.hidden = true
    main.append(saved, ratio)
    const sub = el("div", "dcp-status-sub", "")
    status.append(main, sub)
    root.replaceChildren(status)
    statusRefs = { saved, ratio, sub }
}

// -------------------------------------------------------------------- fetching

async function refreshStats(): Promise<void> {
    const seq = ++fetchSeq
    refs?.refresh.update({ loading: true })
    try {
        const query: Record<string, string> = {}
        if (sessionId) query.session = sessionId
        if (projectDirectory) query.directory = projectDirectory
        const result = await host.serviceRequest({ method: "GET", path: "/stats", query })
        if (seq !== fetchSeq) return
        if (result.status !== 200) {
            throw new Error(`stats service responded with HTTP ${result.status}`)
        }
        payload = JSON.parse(result.body) as StatsPayload
        notice = null
    } catch (error) {
        if (seq !== fetchSeq) return
        notice = describeError(error)
    } finally {
        if (seq === fetchSeq) {
            refs?.refresh.update({ loading: false })
            render()
        }
    }
}

function describeError(error: unknown): Notice {
    if (error instanceof HostRequestError) {
        switch (error.code) {
            case "NO_SERVICE":
                return {
                    tone: "warning",
                    title: "Local service not approved",
                    body: "Open Settings → Extensions, select DCP Stats, and allow its local service. Then retry.",
                }
            case "DISABLED":
                return {
                    tone: "info",
                    title: "DCP Stats is paused",
                    body: "Enable the extension in Settings → Extensions.",
                }
            case "SERVICE_FAILED":
            case "HOST_TIMEOUT":
                return {
                    tone: "error",
                    title: "Stats service is not responding",
                    body: "Retry, or restart OpenChamber if it keeps failing.",
                }
            default:
                return { tone: "error", title: "Could not load DCP stats", body: error.message }
        }
    }
    return {
        tone: "error",
        title: "Could not load DCP stats",
        body: error instanceof Error ? error.message : String(error),
    }
}

function startPolling(): void {
    if (pollTimer !== null) return
    pollTimer = window.setInterval(() => {
        if (document.visibilityState === "visible") void refreshStats()
    }, POLL_MS)
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void refreshStats()
    })
}

// -------------------------------------------------------------------- session

function applySession(session: SessionSnapshot | null): void {
    const nextId = session?.id ?? null
    const nextTitle = session?.title ?? ""
    const changed = nextId !== sessionId || nextTitle !== sessionTitle
    sessionId = nextId
    sessionTitle = nextTitle
    if (changed) void refreshStats()
}

function applyDirectory(directory: string | null): void {
    const next = directory || null
    if (next === projectDirectory) return
    projectDirectory = next
    projectNotice = null
    projectActionError = null
    void refreshStats()
}

async function toggleProjectMode(): Promise<void> {
    if (!refs || !projectDirectory || projectBusy) return
    const project = payload?.project ?? null
    const next = project?.mode === "free" ? "passive" : "free"

    projectNotice = null
    projectActionError = null
    projectBusy = true
    refs.projectAction.update({ loading: true })
    try {
        const result = await host.serviceRequest({
            method: "POST",
            path: "/project-mode",
            body: JSON.stringify({ directory: projectDirectory, mode: next }),
        })
        const body = JSON.parse(result.body) as {
            ok?: boolean
            project?: ProjectStatus
            error?: string
        }
        if (result.status !== 200 || !body.project) {
            throw new Error(body.error || `project-mode service responded with HTTP ${result.status}`)
        }
        if (payload) payload.project = body.project
        projectNotice = `Saved. New sessions use ${body.project.mode} mode after OpenCode restarts.`
        void host
            .toast({
                kind: "success",
                message: `DCP project mode saved (${body.project.mode}). New sessions use it after OpenCode restarts.`,
            })
            .catch(() => {})
    } catch (error) {
        projectActionError = error instanceof Error ? error.message : String(error)
        void host
            .toast({
                kind: "error",
                message: `Could not save the DCP project mode: ${projectActionError}`,
            })
            .catch(() => {})
    } finally {
        projectBusy = false
        refs.projectAction.update({ loading: false })
        render()
    }
}

// -------------------------------------------------------------------- render

function render(): void {
    if (surface === "status") {
        renderStatus()
        return
    }
    if (!refs) return

    refs.subtitle.textContent = sessionTitle || (sessionId ? "Session" : "No session open")
    renderNotice()

    const session = payload?.session ?? null
    const allTime = payload?.allTime ?? null

    renderProject()
    const meta = [session ? formatUpdated(session.lastUpdated) : ""]
    const override = sessionModeOverride(session, payload?.project ?? null)
    if (override) meta.push(override)
    refs.sessionMeta.textContent = meta.filter(Boolean).join(" · ")
    renderMetrics(refs.sessionMetrics, session ? sessionRows(session) : [])
    renderBlocks(refs.blocks, session?.blocks ?? [])
    setHint(refs.sessionHint, sessionHintContent(session))

    renderMetrics(refs.allTimeMetrics, allTime ? allTimeRows(allTime) : [])
    setHint(refs.allTimeHint, allTimeHintContent(allTime))
}

function renderProject(): void {
    if (!refs) return
    if (!projectDirectory) {
        refs.projectSection.hidden = true
        return
    }

    refs.projectSection.hidden = false
    refs.projectName.textContent = projectLabel(projectDirectory)
    refs.projectNotice.hidden = !projectNotice
    refs.projectNotice.textContent = projectNotice ?? ""

    const project = payload?.project ?? null
    if (!project) {
        refs.projectBadge.update({ label: "…", tone: "neutral" })
        refs.projectDescription.textContent = notice
            ? "Project mode unavailable."
            : "Reading project config…"
        refs.projectHint.textContent = projectDirectory
        refs.projectSession.hidden = true
        refs.projectSession.textContent = ""
        refs.projectError.hidden = true
        refs.projectError.textContent = ""
        refs.projectAction.update({ label: "Make passive", disabled: true, loading: projectBusy })
        return
    }

    refs.projectBadge.update({
        label: modeLabel(project.mode),
        tone: modeTone(project.mode),
    })
    refs.projectDescription.textContent = modeDescription(project)
    refs.projectHint.textContent = modeHint(project)
    const sessionNotice = projectSessionNotice(payload?.session ?? null, project)
    refs.projectSession.hidden = !sessionNotice
    refs.projectSession.textContent = sessionNotice

    const error = projectActionError || project.error
    refs.projectError.hidden = !error
    refs.projectError.textContent = error ?? ""
    refs.projectAction.update({
        label: project.mode === "free" ? "Make passive" : "Enable free mode",
        disabled: Boolean(project.projectConfigError) || projectBusy,
        loading: projectBusy,
    })
}

function modeLabel(mode: ProjectStatus["mode"]): string {
    switch (mode) {
        case "off":
            return "Off"
        case "passive":
            return "Passive"
        default:
            return "Free"
    }
}

function modeTone(mode: ProjectStatus["mode"]): "success" | "warning" | "error" {
    switch (mode) {
        case "off":
            return "error"
        case "passive":
            return "warning"
        default:
            return "success"
    }
}

function modeDescription(project: ProjectStatus): string {
    switch (project.mode) {
        case "off":
            return "DCP is disabled for this project."
        case "passive":
            return "Nudges are off. Compression stays available on request; cleanup follows the strategy settings."
        default:
            return "Nudges are on. Compression stays available; cleanup follows the strategy settings."
    }
}

function modeHint(project: ProjectStatus): string {
    const source =
        project.source === "project"
            ? "project config"
            : project.source === "config-dir"
              ? "OpenCode config dir"
              : project.source === "global"
                ? "global DCP config"
                : "DCP defaults"
    const configPath =
        project.source === "project"
            ? project.projectConfigPath
            : project.source === "config-dir"
              ? project.configDirConfigPath
              : project.source === "global"
                ? project.globalConfigPath
                : null
    const location = configPath ? ` · ${configPath}` : ""
    return `Source: ${source}${location} · new sessions after restart`
}

function projectSessionNotice(session: SessionReport | null, project: ProjectStatus): string {
    if (!session) return ""
    if (project.mode === "off") {
        return "This session keeps its current mode until OpenCode restarts."
    }
    const override = sessionModeOverride(session, project)
    if (override === "passive session") {
        return "This session is passive; run /dcp passive off (or /dcp passive reset) to use the project mode now."
    }
    if (override === "free session") {
        return "This session runs free; run /dcp passive on (or /dcp passive reset) to use the project mode now."
    }
    return ""
}

function projectLabel(directory: string): string {
    const trimmed = directory.replace(/[\\/]+$/, "")
    const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
    return index >= 0 ? trimmed.slice(index + 1) || trimmed : trimmed
}

function sessionModeOverride(
    session: SessionReport | null,
    project: ProjectStatus | null,
): string {
    if (!session || session.passiveModeOverride === null || !project || project.mode === "off") {
        return ""
    }
    if (session.passiveModeOverride === project.passiveMode) return ""
    return session.passiveModeOverride ? "passive session" : "free session"
}

function renderNotice(): void {
    if (!refs) return
    noticeHandle?.dispose()
    noticeHandle = null
    refs.notice.replaceChildren()
    if (!notice) return
    const showRetry = notice.tone === "error" || notice.tone === "warning"
    noticeHandle = mountBanner(refs.notice, {
        tone: notice.tone,
        title: notice.title,
        ...(notice.body ? { body: notice.body } : {}),
        ...(showRetry ? { action: { label: "Retry", onClick: () => void refreshStats() } } : {}),
    })
}

function renderStatus(): void {
    if (!statusRefs) return
    const session = payload?.session ?? null
    const allTime = payload?.allTime ?? null
    const mode = statusModeLabel(payload?.project ?? null)

    if (notice) {
        statusRefs.saved.textContent = "DCP"
        statusRefs.ratio.hidden = true
        statusRefs.sub.textContent = notice.title
        statusRefs.sub.classList.add("dcp-status-error")
    } else if (session) {
        statusRefs.saved.textContent = `~${formatTokens(session.tokensIn)} saved`
        statusRefs.ratio.hidden = false
        statusRefs.ratio.textContent = formatRatio(session.tokensIn, session.tokensOut)
        const bits: string[] = []
        if (mode) bits.push(mode)
        bits.push(plural(session.blocks.length, "block"))
        bits.push(plural(session.tools, "tool"))
        if (allTime) bits.push(`all-time ~${formatTokens(allTime.tokens)}`)
        statusRefs.sub.textContent = bits.join(" · ")
        statusRefs.sub.classList.remove("dcp-status-error")
    } else if (payload?.reason === "storage-missing") {
        statusRefs.saved.textContent = "DCP"
        statusRefs.ratio.hidden = true
        statusRefs.sub.textContent = [mode, "DCP state folder not found"].filter(Boolean).join(" · ")
        statusRefs.sub.classList.add("dcp-status-error")
    } else {
        statusRefs.saved.textContent = "DCP"
        statusRefs.ratio.hidden = true
        const bits = [mode]
        bits.push(sessionId ? "No DCP state for this session yet" : "No session open")
        statusRefs.sub.textContent = bits.filter(Boolean).join(" · ")
        statusRefs.sub.classList.remove("dcp-status-error")
    }

    syncStatusHeight()
}

function statusModeLabel(project: ProjectStatus | null): string {
    if (!project) return ""
    if (project.mode === "off") return "disabled"
    if (project.mode === "passive") return "passive"
    return ""
}

function renderMetrics(container: HTMLElement, rows: MetricRow[]): void {
    container.replaceChildren(
        ...rows.map((row) => {
            const item = el("div", "dcp-metric")
            const label = el("span", "dcp-metric-label", row.label)
            const value = el("span", "dcp-metric-value", row.value)
            if (row.tone) value.dataset.tone = row.tone
            item.append(label, value)
            return item
        }),
    )
    container.hidden = rows.length === 0
}

function renderBlocks(container: HTMLElement, blocks: ActiveBlock[]): void {
    container.replaceChildren(
        ...blocks.map((block) => {
            const card = el("div", "dcp-block")
            const top = el("div", "dcp-block-top")
            top.append(
                el("span", "dcp-block-topic", block.topic || `Block #${block.blockId}`),
                el(
                    "span",
                    "dcp-block-ratio",
                    formatRatio(block.compressedTokens, block.summaryTokens),
                ),
            )
            const details: string[] = [
                `${formatTokens(block.compressedTokens)} → ${formatTokens(block.summaryTokens)}`,
                plural(block.toolCount, "tool"),
                plural(block.messageCount, "msg"),
            ]
            const age = formatAge(block.createdAt)
            if (age) details.push(age)
            const sub = el("div", "dcp-block-sub", details.join(" · "))
            card.append(top, sub)
            return card
        }),
    )
}

function sessionHintContent(session: SessionReport | null): (Node | string)[] | null {
    if (payload === null) return ["Loading DCP stats…"]
    if (payload.reason === "storage-missing") {
        return [
            "DCP state folder not found: ",
            el("code", undefined, payload.storageDir),
            ". If OpenCode stores its data elsewhere (custom XDG_DATA_HOME), the extension cannot see it.",
        ]
    }
    if (!sessionId) return ["No session is open. Open a chat to see its DCP stats."]
    if (!session) return ["No DCP state for this session yet. It appears after DCP compresses something."]
    if (session.blocks.length === 0) return ["No active compressions."]
    return null
}

function allTimeHintContent(allTime: AllTime | null): (Node | string)[] | null {
    if (payload === null || payload.reason === "storage-missing") return null
    if (!allTime) return ["No all-time data."]
    return null
}

function setHint(node: HTMLElement, content: (Node | string)[] | null): void {
    if (!content || content.length === 0) {
        node.hidden = true
        node.replaceChildren()
        return
    }
    node.hidden = false
    node.replaceChildren(...content)
}

function syncStatusHeight(): void {
    if (surface !== "status") return
    const node = root.firstElementChild
    if (!(node instanceof HTMLElement)) return
    const height = Math.ceil(node.scrollHeight)
    if (height <= 0 || height === lastStatusHeight) return
    lastStatusHeight = height
    void host.setHeight(height).catch(() => {})
}

// -------------------------------------------------------------------- rows

function sessionRows(session: SessionReport): MetricRow[] {
    const usage = session.usage
    return [
        {
            label: "Tokens in|out",
            value: `~${formatTokens(session.tokensIn)} | ~${formatTokens(session.tokensOut)}`,
        },
        { label: "Ratio", value: formatRatio(session.tokensIn, session.tokensOut) },
        { label: "Time", value: formatDuration(session.durationMs) },
        { label: "Messages", value: String(session.messages) },
        { label: "Tools", value: String(session.tools) },
        {
            label: "Summary requests",
            value: `${usage.calls} (${usage.providerCalls} provider, ${usage.estimatedCalls} estimated)`,
        },
        {
            label: "Request in|out",
            value: `~${formatTokens(usage.inputTokens)} | ~${formatTokens(usage.outputTokens)}`,
        },
        {
            label: "Request cache",
            value: `~${formatTokens(usage.cacheReadTokens)} read | ~${formatTokens(usage.cacheWriteTokens)} write`,
        },
        { label: "Request reasoning", value: `~${formatTokens(usage.reasoningTokens)}` },
    ]
}

function allTimeRows(allTime: AllTime): MetricRow[] {
    return [
        { label: "Tokens saved", value: `~${formatTokens(allTime.tokens)}`, tone: "success" },
        { label: "Tools pruned", value: String(allTime.tools) },
        { label: "Messages pruned", value: String(allTime.messages) },
        { label: "Sessions", value: String(allTime.sessions) },
        {
            label: "Summary requests",
            value: `${allTime.usage.calls} (~${formatTokens(allTime.usage.inputTokens)} in | ~${formatTokens(allTime.usage.outputTokens)} out)`,
        },
    ]
}

// -------------------------------------------------------------------- format

/** Same shape as the DCP `/dcp stats` output (`formatTokenCount`). */
function formatTokens(tokens: number): string {
    const value = Math.max(0, Math.round(tokens))
    if (value >= 1000) {
        return `${(value / 1000).toFixed(1)}`.replace(/\.0$/, "") + "K"
    }
    return String(value)
}

function formatRatio(inputTokens: number, outputTokens: number): string {
    if (inputTokens <= 0) return "0:1"
    if (outputTokens <= 0) return "∞:1"
    return `${Math.max(1, Math.round(inputTokens / outputTokens))}:1`
}

function formatDuration(ms: number): string {
    const safe = Math.max(0, Math.round(ms))
    if (safe < 1000) return `${safe} ms`
    const totalSeconds = safe / 1000
    if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`
    const wholeSeconds = Math.floor(totalSeconds)
    const hours = Math.floor(wholeSeconds / 3600)
    const minutes = Math.floor((wholeSeconds % 3600) / 60)
    const seconds = wholeSeconds % 60
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
    return `${minutes}m ${seconds}s`
}

function formatAge(timestamp: number): string {
    if (!timestamp || !Number.isFinite(timestamp)) return ""
    const delta = Date.now() - timestamp
    if (delta < 60_000) return "just now"
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
}

function formatUpdated(lastUpdated: string | null): string {
    if (!lastUpdated) return ""
    const timestamp = Date.parse(lastUpdated)
    if (!Number.isFinite(timestamp)) return ""
    const age = formatAge(timestamp)
    return age ? `updated ${age}` : ""
}

function plural(count: number, noun: string): string {
    return count === 1 ? `1 ${noun}` : `${count} ${noun}s`
}

// -------------------------------------------------------------------- wiring

host.onReady((ctx: HostReadyContext) => {
    applyHostReady(ctx, document.documentElement)
    surface = ctx.surface === "status" ? "status" : "panel"
    if (!mounted) {
        mounted = true
        if (surface === "status") mountStatus()
        else mountPanel()
        startPolling()
    }
    if (!directoryWired) {
        directoryWired = true
        host.onDirectory((directory) => {
            applyDirectory(directory)
        })
    }
    applyDirectory(ctx.directory)
    applySession(ctx.session)
    render()
})

host.onSession((session) => {
    applySession(session)
})

host.onSessionLifecycle(() => {
    void refreshStats()
})
