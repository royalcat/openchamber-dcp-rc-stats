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
    "manualMode": {
        "enabled": true,
        "automaticStrategies": false,
        "allowCompressTool": true,
    },
}
`

const automatic = `{
    "manualMode": {
        "enabled": false,
        "automaticStrategies": true,
        "allowCompressTool": false,
    },
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

test("defaults to automatic with no config files", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })

    const status = await new ProjectConfigStore(envFor(root)).getStatus(project)
    assert.equal(status.mode, "automatic")
    assert.equal(status.source, "default")
    assert.equal(status.enabled, true)
    assert.equal(status.manualMode, false)
    assert.equal(status.automaticStrategies, true)
    assert.equal(status.allowCompressTool, false)
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
    assert.equal(status.mode, "automatic")
    assert.equal(status.source, "default")
    assert.equal(status.error, undefined)
    assert.equal(status.projectConfigError, undefined)
})

test("reads the passive project recipe", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    const configPath = path.join(project, ".opencode", "dcp-rc.jsonc")
    await write(configPath, passive)

    const status = await new ProjectConfigStore(envFor(root)).getStatus(project)
    assert.equal(status.mode, "passive")
    assert.equal(status.source, "project")
    assert.equal(status.manualMode, true)
    assert.equal(status.automaticStrategies, false)
    assert.equal(status.allowCompressTool, true)
    assert.equal(status.projectConfigPath, configPath)
})

test("project layers override global layers", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    await write(path.join(root, "global", "dcp-rc.jsonc"), passive)
    await write(path.join(project, ".opencode", "dcp-rc.jsonc"), automatic)

    const status = await new ProjectConfigStore(envFor(root)).getStatus(project)
    assert.equal(status.mode, "automatic")
    assert.equal(status.source, "project")
    assert.equal(status.manualMode, false)
})

test("enabled false reports off", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    await write(
        path.join(project, ".opencode", "dcp-rc.jsonc"),
        `{
            "enabled": false,
            "manualMode": {
                "enabled": true,
                "automaticStrategies": false,
                "allowCompressTool": true,
            },
        }
`,
    )

    const status = await new ProjectConfigStore(envFor(root)).getStatus(project)
    assert.equal(status.mode, "off")
    assert.equal(status.enabled, false)
})

test("manual mode with strategies reports manual", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    await write(
        path.join(project, ".opencode", "dcp-rc.jsonc"),
        `{
            "manualMode": {
                "enabled": true,
                "automaticStrategies": true,
            },
        }
`,
    )

    const status = await new ProjectConfigStore(envFor(root)).getStatus(project)
    assert.equal(status.mode, "manual")
    assert.equal(status.automaticStrategies, true)
})

test("invalid project JSONC is reported and never rewritten", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    const configPath = path.join(project, ".opencode", "dcp-rc.jsonc")
    const broken = `{ "manualMode": { "enabled": true, `
    await write(configPath, broken)

    const store = new ProjectConfigStore(envFor(root))
    const status = await store.getStatus(project)
    assert.equal(status.mode, "automatic")
    assert.ok(status.projectConfigError)
    assert.ok(status.error)

    await assert.rejects(
        () => store.setMode(project, "passive"),
        (error: unknown) => error instanceof ProjectConfigError && error.code === "invalid-config",
    )
    assert.equal(await fs.readFile(configPath, "utf-8"), broken)
})

test("setMode writes the passive recipe and preserves comments and other keys", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    const configPath = path.join(project, ".opencode", "dcp-rc.jsonc")
    await write(
        configPath,
        `{
    // keep this
    "debug": true,
    "manualMode": {
        "enabled": false, // turn on later
        "automaticStrategies": true,
    },
}
`,
    )

    const store = new ProjectConfigStore(envFor(root))
    const status = await store.setMode(project, "passive")
    assert.equal(status.mode, "passive")

    const text = await fs.readFile(configPath, "utf-8")
    assert.match(text, /keep this/)
    assert.match(text, /"debug": true/)
    assert.match(text, /"enabled": true/)
    assert.match(text, /"automaticStrategies": false/)
    assert.match(text, /"allowCompressTool": true/)
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
    assert.match(text, /"manualMode"/)
    assert.match(text, /"allowCompressTool": true/)
})

test("setMode toggles back to automatic", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    const configPath = path.join(project, ".opencode", "dcp-rc.jsonc")
    await write(configPath, passive)

    const status = await new ProjectConfigStore(envFor(root)).setMode(project, "automatic")
    assert.equal(status.mode, "automatic")

    const text = await fs.readFile(configPath, "utf-8")
    assert.match(text, /"manualMode"/)
    assert.match(text, /"enabled": false/)
    assert.match(text, /"automaticStrategies": true/)
    assert.match(text, /"allowCompressTool": false/)
})

test("setMode edits an existing dcp-rc.json instead of creating a jsonc", async (t) => {
    const root = await tempRoot(t)
    const project = path.join(root, "project")
    const jsonPath = path.join(project, ".opencode", "dcp-rc.json")
    await write(jsonPath, automatic)

    const status = await new ProjectConfigStore(envFor(root)).setMode(project, "passive")
    assert.equal(status.mode, "passive")
    assert.equal(await fs.readFile(jsonPath, "utf-8").then(() => true), true)

    const text = await fs.readFile(jsonPath, "utf-8")
    assert.match(text, /"manualMode"/)
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
    await write(path.join(configDir, "dcp-rc.jsonc"), automatic)

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
        () => store.setMode(root, "off" as "automatic"),
        (error: unknown) => error instanceof ProjectConfigError && error.code === "invalid-mode",
    )
})
