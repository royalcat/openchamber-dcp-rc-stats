/**
 * DCP RC project configuration.
 *
 * Mirrors the config layers of `@royalcat/opencode-dcp-rc`
 * (`lib/config.ts`):
 *
 *   global     `$XDG_CONFIG_HOME/opencode/dcp-rc.jsonc|json`
 *   config dir `$OPENCODE_CONFIG_DIR/dcp-rc.jsonc|json`
 *   project    nearest `.opencode/dcp-rc.jsonc|json` above the session dir
 *
 * The extension only needs the keys that decide whether the project runs DCP
 * automatically, passively, or not at all. The full plugin config is still
 * read by DCP itself; this module never rewrites unrelated keys or comments.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser/lib/esm/main.js"
import type { ParseError } from "jsonc-parser/lib/esm/main.js"

export type ProjectMode = "automatic" | "passive" | "manual" | "off"
export type ProjectModeSource = "project" | "config-dir" | "global" | "default"
export type WritableProjectMode = "automatic" | "passive"

export interface ProjectStatus {
    directory: string
    mode: ProjectMode
    source: ProjectModeSource
    enabled: boolean
    manualMode: boolean
    automaticStrategies: boolean
    allowCompressTool: boolean
    projectConfigPath: string | null
    globalConfigPath: string | null
    configDirConfigPath: string | null
    /** Any config file could not be parsed or had an invalid key type. */
    error?: string
    /** The project file itself is invalid, so the panel must not rewrite it. */
    projectConfigError?: string
}

export class ProjectConfigError extends Error {
    constructor(
        message: string,
        readonly code:
            | "invalid-directory"
            | "invalid-mode"
            | "invalid-config"
            | "write-failed" = "invalid-config",
    ) {
        super(message)
        this.name = "ProjectConfigError"
    }
}

interface EffectiveConfig {
    enabled: boolean
    manualMode: boolean
    automaticStrategies: boolean
    allowCompressTool: boolean
}

const DEFAULT_CONFIG: EffectiveConfig = {
    enabled: true,
    manualMode: false,
    automaticStrategies: true,
    allowCompressTool: false,
}

interface ConfigPaths {
    global: string | null
    configDir: string | null
    project: string | null
}

interface ParsedConfig {
    data: Record<string, unknown> | null
    error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBoolean(value: unknown): value is boolean {
    return typeof value === "boolean"
}

async function isFile(filePath: string): Promise<boolean> {
    try {
        return (await fs.stat(filePath)).isFile()
    } catch {
        return false
    }
}

/** `findOpencodeDir` from the plugin: the nearest existing `.opencode` above a directory. */
export async function findOpencodeDir(startDirectory: string): Promise<string | null> {
    let current = path.resolve(startDirectory)
    while (true) {
        const candidate = path.join(current, ".opencode")
        try {
            if ((await fs.stat(candidate)).isDirectory()) return candidate
        } catch {
            // keep walking
        }
        const parent = path.dirname(current)
        if (parent === current) return null
        current = parent
    }
}

async function pickConfigFile(directory: string): Promise<string | null> {
    const jsonc = path.join(directory, "dcp-rc.jsonc")
    if (await isFile(jsonc)) return jsonc
    const json = path.join(directory, "dcp-rc.json")
    if (await isFile(json)) return json
    return null
}

/** Resolve the three config layers the plugin merges. */
export async function resolveConfigPaths(
    directory: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigPaths> {
    const override = env.OPENCHAMBER_DCP_GLOBAL_CONFIG_DIR?.trim()
    const configHome =
        override ||
        path.join(
            env.XDG_CONFIG_HOME?.trim() ||
                path.join(env.HOME?.trim() || os.homedir(), ".config"),
            "opencode",
        )

    const configDir = env.OPENCODE_CONFIG_DIR?.trim() || null
    const opencodeDir = await findOpencodeDir(directory)

    return {
        global: await pickConfigFile(configHome),
        configDir: configDir ? await pickConfigFile(configDir) : null,
        project: opencodeDir ? await pickConfigFile(opencodeDir) : null,
    }
}

export function normalizeDirectory(value: string): string | null {
    const trimmed = value.trim()
    if (!trimmed || !path.isAbsolute(trimmed)) return null
    return path.resolve(trimmed)
}

function parseConfigText(text: string, filePath: string): ParsedConfig {
    if (text.trim() === "") return { data: null }

    // A comments-only file is how the plugin writes its default global config.
    // `jsonc-parser` reports it as `undefined` with an error; treat it as empty
    // rather than showing a permanent warning in the panel.
    const hasTokens = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .trim()
    if (hasTokens === "") return { data: null }

    const errors: ParseError[] = []
    let parsed: unknown
    try {
        parsed = parse(text, errors, { allowTrailingComma: true })
    } catch (error) {
        return {
            data: null,
            error: `${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        }
    }

    if (errors.length > 0) {
        const first = errors[0]!
        return {
            data: null,
            error: `${filePath}: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
        }
    }
    if (!isRecord(parsed)) {
        return { data: null, error: `${filePath}: config root must be an object` }
    }
    return { data: parsed }
}

async function readConfigFile(filePath: string | null): Promise<ParsedConfig> {
    if (!filePath) return { data: null }

    let text: string
    try {
        text = await fs.readFile(filePath, "utf-8")
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { data: null }
        return {
            data: null,
            error: `${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        }
    }

    return parseConfigText(text, filePath)
}

interface AppliedLayer {
    config: EffectiveConfig
    touched: boolean
    errors: string[]
}

function applyLayer(base: EffectiveConfig, data: Record<string, unknown>, filePath: string): AppliedLayer {
    const config = { ...base }
    const errors: string[] = []
    let touched = false

    if ("enabled" in data) {
        if (isBoolean(data.enabled)) {
            config.enabled = data.enabled
            touched = true
        } else {
            errors.push(`${filePath}: enabled must be a boolean`)
        }
    }

    if ("manualMode" in data) {
        const manual = data.manualMode
        if (!isRecord(manual)) {
            errors.push(`${filePath}: manualMode must be an object`)
        } else {
            if ("enabled" in manual) {
                if (isBoolean(manual.enabled)) {
                    config.manualMode = manual.enabled
                    touched = true
                } else {
                    errors.push(`${filePath}: manualMode.enabled must be a boolean`)
                }
            }
            if ("automaticStrategies" in manual) {
                if (isBoolean(manual.automaticStrategies)) {
                    config.automaticStrategies = manual.automaticStrategies
                    touched = true
                } else {
                    errors.push(`${filePath}: manualMode.automaticStrategies must be a boolean`)
                }
            }
            if ("allowCompressTool" in manual) {
                if (isBoolean(manual.allowCompressTool)) {
                    config.allowCompressTool = manual.allowCompressTool
                    touched = true
                } else {
                    errors.push(`${filePath}: manualMode.allowCompressTool must be a boolean`)
                }
            }
        }
    }

    return { config, touched, errors }
}

function deriveMode(config: EffectiveConfig): ProjectMode {
    if (!config.enabled) return "off"
    if (!config.manualMode) return "automatic"
    return config.automaticStrategies ? "manual" : "passive"
}

function buildStatus(
    directory: string,
    paths: ConfigPaths,
    config: EffectiveConfig,
    source: ProjectModeSource,
    errors: string[],
    projectConfigError: string | null,
): ProjectStatus {
    return {
        directory,
        mode: deriveMode(config),
        source,
        enabled: config.enabled,
        manualMode: config.manualMode,
        automaticStrategies: config.automaticStrategies,
        allowCompressTool: config.allowCompressTool,
        projectConfigPath: paths.project,
        globalConfigPath: paths.global,
        configDirConfigPath: paths.configDir,
        ...(errors.length > 0 ? { error: errors.join("\n") } : {}),
        ...(projectConfigError ? { projectConfigError } : {}),
    }
}

function template(mode: WritableProjectMode): string {
    const passive = mode === "passive"
    return `{
    // DCP Stats: ${passive ? "passive project (compression on request only)" : "automatic compression for this project"}.
    "enabled": true,
    "manualMode": {
        "enabled": ${passive},
        "automaticStrategies": ${!passive},
        "allowCompressTool": ${passive},
    },
}
`
}

const FORMATTING = { insertSpaces: true, tabSize: 4, eol: "\n" } as const

async function resolveWriteTarget(
    directory: string,
    projectConfigPath: string | null,
): Promise<{ path: string; exists: boolean }> {
    if (projectConfigPath) return { path: projectConfigPath, exists: true }

    const opencodeDir = await findOpencodeDir(directory)
    if (opencodeDir) {
        return { path: path.join(opencodeDir, "dcp-rc.jsonc"), exists: false }
    }
    return {
        path: path.join(directory, ".opencode", "dcp-rc.jsonc"),
        exists: false,
    }
}

export class ProjectConfigStore {
    private readonly env: NodeJS.ProcessEnv

    constructor(env: NodeJS.ProcessEnv = process.env) {
        this.env = env
    }

    async getStatus(directoryInput: string): Promise<ProjectStatus> {
        const directory = normalizeDirectory(directoryInput)
        if (!directory) {
            throw new ProjectConfigError("Project directory must be an absolute path", "invalid-directory")
        }

        const paths = await resolveConfigPaths(directory, this.env)
        const layers: Array<{ name: Exclude<ProjectModeSource, "default">; path: string | null }> = [
            { name: "global", path: paths.global },
            { name: "config-dir", path: paths.configDir },
            { name: "project", path: paths.project },
        ]

        let config: EffectiveConfig = { ...DEFAULT_CONFIG }
        let source: ProjectModeSource = "default"
        const errors: string[] = []
        let projectConfigError: string | null = null

        for (const layer of layers) {
            if (!layer.path) continue
            const parsed = await readConfigFile(layer.path)
            if (parsed.error) {
                errors.push(parsed.error)
                if (layer.name === "project") projectConfigError = parsed.error
                continue
            }
            if (!parsed.data) continue

            const applied = applyLayer(config, parsed.data, layer.path)
            config = applied.config
            if (applied.touched) source = layer.name
            if (applied.errors.length > 0) {
                errors.push(...applied.errors)
                if (layer.name === "project") {
                    projectConfigError = applied.errors.join("\n")
                }
            }
        }

        return buildStatus(directory, paths, config, source, errors, projectConfigError)
    }

    async setMode(directoryInput: string, mode: WritableProjectMode): Promise<ProjectStatus> {
        if (mode !== "automatic" && mode !== "passive") {
            throw new ProjectConfigError("Project mode must be automatic or passive", "invalid-mode")
        }

        const status = await this.getStatus(directoryInput)
        if (status.projectConfigError) {
            throw new ProjectConfigError(
                `Project config is invalid and was not changed: ${status.projectConfigError}`,
                "invalid-config",
            )
        }

        const target = await resolveWriteTarget(status.directory, status.projectConfigPath)
        const passive = mode === "passive"
        const changes: Array<{ path: string[]; value: boolean }> = [
            { path: ["manualMode", "enabled"], value: passive },
            { path: ["manualMode", "automaticStrategies"], value: !passive },
            { path: ["manualMode", "allowCompressTool"], value: passive },
        ]
        if (!status.enabled) {
            changes.unshift({ path: ["enabled"], value: true })
        }

        let text: string
        if (target.exists) {
            try {
                text = await fs.readFile(target.path, "utf-8")
            } catch (error) {
                throw new ProjectConfigError(
                    `Could not read ${target.path}: ${error instanceof Error ? error.message : String(error)}`,
                    "write-failed",
                )
            }
            if (text.trim() === "") text = "{}\n"
            for (const change of changes) {
                const edits = modify(text, change.path, change.value, {
                    formattingOptions: FORMATTING,
                })
                text = applyEdits(text, edits)
            }
        } else {
            text = template(mode)
        }

        try {
            await fs.mkdir(path.dirname(target.path), { recursive: true })
            await fs.writeFile(target.path, text, "utf-8")
        } catch (error) {
            throw new ProjectConfigError(
                `Could not write ${target.path}: ${error instanceof Error ? error.message : String(error)}`,
                "write-failed",
            )
        }

        const next = await this.getStatus(status.directory)
        if (next.projectConfigError) {
            throw new ProjectConfigError(
                `Wrote ${target.path}, but the result is invalid: ${next.projectConfigError}`,
                "write-failed",
            )
        }
        return next
    }
}
