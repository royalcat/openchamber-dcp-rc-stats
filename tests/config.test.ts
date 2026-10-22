import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
    ProjectConfigError,
    ProjectConfigStore,
    findOpencodeDir,
    resolveConfigPaths,
} from "../service/config"

async function tempRoot(t: { after: (fn: () => void | Promise<void>) => void }): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dcp-config-"))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    return root
}

function envFor(root: string): NodeJS.ProcessEnv {
    return {
        HOME: path.join(root, "home"),
        OPENCHAMBER_DCP_GLOBAL_CONFIG_DIR: path.join(root, "global"),
    }
}

async function write(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, "utf-8")
}

const passive = `{
    // passive project
    "passiveMode": true,
}
`

const free = `{
    "passiveMode": false,
}
`

test("findOpencodeDir finds the nearest .opencode above the directory", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    const nested = path.join(project, "src", "deep")
    await fs.mkdir(nested, { recursive: true })

    assert.equal(await findOpencodeDir(nested), null)

    await fs.mkdir(path.join(root, ".opencode"))
    assert.equal(await findOpencodeDir(nested), path.join(root, ".opencode"))

    await fs.mkdir(path.join(project, ".opencode"))
    assert.equal(await findOpencodeDir(nested), path.join(project, ".opencode"))
})

test("defaults to free with no config files", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })

    const status = await new ProjectConfigStore(envFor(root)).getStatus(project)
    assert.equal(status.mode, "free")
    assert.equal(status.source, "default")
    assert.equal(status.enabled, true)
    assert.equal(status.passiveMode, false)
    assert.equal(status.projectConfigPath, null)
    assert.equal(status.globalConfigPath, null)
    assert.equal(status.error, undefined)
})

test("comments-only config files are treated as empty", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    await write(
        path.join(root, "global", "dcp-rc.jsonc"),
        `{
            // plugin default config
        }
`,
    )
    await write(path.join(project, ".opencode", "dcp-rc.jsonc"), "// no project settings\n")

    const status = await new ProjectConfigStore(envFor(root)).getStatus(project)
    assert.equal(status.mode, "free")
    assert.equal(status.source, "default")
    assert.equal(status.error, undefined)
    assert.equal(status.projectConfigError, undefined)
})

test("reads the passive project config", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    const configPath = path.join(project, ".opencode", "dcp-rc.jsonc")
    await write(configPath, passive)

    const status = await new ProjectConfigStore(envFor(root)).getStatus(project)
    assert.equal(status.mode, "passive")
    assert.equal(status.source, "project")
    assert.equal(status.passiveMode, true)
    assert.equal(status.projectConfigPath, configPath)
})

test("project layers override global layers", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    await write(path.join(root, "global", "dcp-rc.jsonc"), passive)
    await write(path.join(project, ".opencode", "dcp-rc.jsonc"), free)

    const status = await new ProjectConfigStore(envFor(root)).getStatus(project)
    assert.equal(status.mode, "free")
    assert.equal(status.source, "project")
    assert.equal(status.passiveMode, false)
})

test("enabled false reports off", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    await write(
        path.join(project, ".opencode", "dcp-rc.jsonc"),
        `{
            "enabled": false,
            "passiveMode": true,
        }
`,
    )

    const status = await new ProjectConfigStore(envFor(root)).getStatus(project)
    assert.equal(status.mode, "off")
    assert.equal(status.enabled, false)
    assert.equal(status.passiveMode, true)
})

test("a stale manualMode block has no effect", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    await write(
        path.join(project, ".opencode", "dcp-rc.jsonc"),
        `{
            "manualMode": {
                "enabled": true,
                "automaticStrategies": false,
                "allowCompressTool": true,
            },
        }
`,
    )

    const status = await new ProjectConfigStore(envFor(root)).getStatus(project)
    assert.equal(status.mode, "free")
    assert.equal(status.passiveMode, false)
    assert.equal(status.error, undefined)
    assert.equal(status.projectConfigError, undefined)
})

test("invalid project JSONC is reported and never rewritten", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    const configPath = path.join(project, ".opencode", "dcp-rc.jsonc")
    const broken = `{ "passiveMode": true, `
    await write(configPath, broken)

    const store = new ProjectConfigStore(envFor(root))
    const status = await store.getStatus(project)
    assert.equal(status.mode, "free")
    assert.ok(status.projectConfigError)
    assert.ok(status.error)

    await assert.rejects(
        () => store.setMode(project, "passive"),
        (error: unknown) => error instanceof ProjectConfigError && error.code === "invalid-config",
    )
    assert.equal(await fs.readFile(configPath, "utf-8"), broken)
})

test("a malformed passiveMode type is reported and blocks writes", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    const configPath = path.join(project, ".opencode", "dcp-rc.jsonc")
    const broken = `{ "passiveMode": "yes" }\n`
    await write(configPath, broken)

    const store = new ProjectConfigStore(envFor(root))
    const status = await store.getStatus(project)
    assert.equal(status.mode, "free")
    assert.match(status.error ?? "", /passiveMode must be a boolean/)
    assert.ok(status.projectConfigError)

    await assert.rejects(
        () => store.setMode(project, "passive"),
        (error: unknown) => error instanceof ProjectConfigError && error.code === "invalid-config",
    )
    assert.equal(await fs.readFile(configPath, "utf-8"), broken)
})

test("setMode writes the passive config and preserves comments and other keys", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    const configPath = path.join(project, ".opencode", "dcp-rc.jsonc")
    await write(
        configPath,
        `{
    // keep this
    "debug": true,
    "passiveMode": false, // turn on later
}
`,
    )

    const store = new ProjectConfigStore(envFor(root))
    const status = await store.setMode(project, "passive")
    assert.equal(status.mode, "passive")

    const text = await fs.readFile(configPath, "utf-8")
    assert.match(text, /keep this/)
    assert.match(text, /"debug": true/)
    assert.match(text, /"passiveMode": true/)
    assert.doesNotMatch(text, /"manualMode"/)
})

test("setMode creates .opencode/dcp-rc.jsonc when no config exists", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })

    const store = new ProjectConfigStore(envFor(root))
    const status = await store.setMode(project, "passive")
    assert.equal(status.mode, "passive")

    const text = await fs.readFile(path.join(project, ".opencode", "dcp-rc.jsonc"), "utf-8")
    assert.match(text, /"enabled": true/)
    assert.match(text, /"passiveMode": true/)
    assert.doesNotMatch(text, /"manualMode"/)
})

test("setMode toggles back to free", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    const configPath = path.join(project, ".opencode", "dcp-rc.jsonc")
    await write(configPath, passive)

    const status = await new ProjectConfigStore(envFor(root)).setMode(project, "free")
    assert.equal(status.mode, "free")

    const text = await fs.readFile(configPath, "utf-8")
    assert.match(text, /"passiveMode": false/)
})

test("setMode re-enables a disabled project", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    const configPath = path.join(project, ".opencode", "dcp-rc.jsonc")
    await write(configPath, `{ "enabled": false, "passiveMode": true }\n`)

    const status = await new ProjectConfigStore(envFor(root)).setMode(project, "passive")
    assert.equal(status.mode, "passive")
    assert.equal(status.enabled, true)

    const text = await fs.readFile(configPath, "utf-8")
    assert.match(text, /"enabled": true/)
    assert.match(text, /"passiveMode": true/)
})

test("setMode edits an existing dcp-rc.json instead of creating a jsonc", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    const jsonPath = path.join(project, ".opencode", "dcp-rc.json")
    await write(jsonPath, free)

    const status = await new ProjectConfigStore(envFor(root)).setMode(project, "passive")
    assert.equal(status.mode, "passive")

    const text = await fs.readFile(jsonPath, "utf-8")
    assert.match(text, /"passiveMode": true/)
    await assert.rejects(() => fs.stat(path.join(project, ".opencode", "dcp-rc.jsonc")))
})

test("setMode writes to the nearest .opencode above a nested project", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    const nested = path.join(project, "src")
    await fs.mkdir(nested, { recursive: true })
    await fs.mkdir(path.join(project, ".opencode"))

    const status = await new ProjectConfigStore(envFor(root)).setMode(nested, "passive")
    assert.equal(status.mode, "passive")
    assert.equal(status.projectConfigPath, path.join(project, ".opencode", "dcp-rc.jsonc"))
})

test("resolveConfigPaths honours OPENCODE_CONFIG_DIR", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    const configDir = path.join(root, "config-dir")
    await fs.mkdir(project, { recursive: true })
    await write(path.join(configDir, "dcp-rc.jsonc"), free)

    const paths = await resolveConfigPaths(project, {
        ...envFor(root),
        OPENCODE_CONFIG_DIR: configDir,
    })
    assert.equal(paths.configDir, path.join(configDir, "dcp-rc.jsonc"))
})

test("setMode rejects relative directories and unknown modes", async (t) => {
    const root = await tempRoot(t)
    const store = new ProjectConfigStore(envFor(root))

    await assert.rejects(
        () => store.setMode("relative/path", "passive"),
        (error: unknown) => error instanceof ProjectConfigError && error.code === "invalid-directory",
    )
    await assert.rejects(
        () => store.setMode(root, "off" as "free"),
        (error: unknown) => error instanceof ProjectConfigError && error.code === "invalid-mode",
    )
})
