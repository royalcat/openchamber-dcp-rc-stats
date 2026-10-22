# AGENTS.md — DCP RC Stats for OpenChamber

## What this repository is

An OpenChamber extension (guest package) that reads the state and config of
[`@royalcat/opencode-dcp-rc`](https://github.com/royalcat/opencode-dcp-rc) and
shows its compression savings. It contributes:

- a rail panel with session stats, active compressions, all-time totals, and a
  **Project** section with the effective DCP mode and a free/passive toggle;
- a compact section in the chat's Work Status panel;
- a local Node service that reads DCP state/config files and writes the
  project's DCP config when the mode button is used.

The extension itself never talks to the OpenCode API. The panel calls the local
service through OpenChamber's loopback proxy, and the service reads files under
`$HOME` directly. This keeps the panel usable on instances protected by a UI
password.

The sibling plugin checkout, when present, is usually
`../opencode-dcp-rc`. Its `lib/config.ts` is the source of truth for the config
layers and defaults mirrored here.

## Commands

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run test        # node:test through tsx, tests/*.test.ts
bun run build       # panel/main.js (IIFE) + service/main.js (ESM)
bun run smoke       # starts the built service and exercises the HTTP endpoints
```

`panel/main.js` and `service/main.js` are **built artifacts committed to the
repository**. OpenChamber never compiles an extension at install time, so every
source change must be followed by `bun run build` and the rebuilt files committed.

The panel bundle is a browser IIFE; the service bundle is Node ESM. The build
uses `bunx openchamber-guest-bundle` from `@openchamber/sdk`.

## Layout

- `panel/main.ts` — one page for both surfaces. `ctx.surface` is `panel`,
  `status`, or another host surface. It renders with plain DOM plus
  `mountButton`, `mountBadge`, and `mountBanner` from `@openchamber/sdk/ui`.
  The page polls `/stats` every 4 seconds while visible.
- `panel/panel.css` — panel styling. Host theme tokens are applied by
  `applyHostReady`; use the `--surface-*` / `--oc-*` fallbacks already present.
- `panel/index.html` — the guest entry. The `panel` and `statusSection`
  contributions share it.
- `service/main.ts` — loopback HTTP service. Endpoints:
  - `GET /health` → `{ ok: true }`
  - `GET /stats?session=ID&directory=PATH` → `StatsPayload`
  - `POST /project-mode` with `{ directory, mode: "free" | "passive" }`
  - Every request, including `/health`, requires
    `Authorization: Bearer $OPENCHAMBER_SERVICE_TOKEN`.
- `service/stats.ts` — DCP session/all-time aggregation. Mirrors the plugin's
  `buildStatsReport` / `loadAllSessionStats`. Treat persisted JSON as untrusted:
  validate every field, skip malformed files, never throw.
- `service/config.ts` — DCP config discovery, effective project mode, and
  JSONC-preserving writes. Mirrors the plugin's `getConfig` layer order.
- `scripts/smoke.mjs` — runs the built service against temporary storage,
  project, and global-config directories; checks auth, stats, project status,
  and the project-mode toggle.
- `tests/stats.test.ts`, `tests/config.test.ts` — unit tests for aggregation and
  config behavior.

## Data sources

Per-session DCP state:

```
~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
```

The service reproduces `/dcp stats`: tokens saved, summary size, ratio,
compression time, pruned messages/tools, hidden summary-request usage, and
all-time totals. State files are cached by mtime and size. The top-level
`passiveMode` field is the session's `/dcp passive` override; when absent, the
session follows the config.

DCP config layers, lowest to highest precedence:

```
$XDG_CONFIG_HOME/opencode/dcp-rc.jsonc|json   (default ~/.config/opencode)
$OPENCODE_CONFIG_DIR/dcp-rc.jsonc|json
<nearest .opencode>/dcp-rc.jsonc|json          (walking up from the project)
```

The plugin filename is `dcp-rc.jsonc` / `dcp-rc.json`; a leading-dot
`.dcp-rc.jsonc` is **not** read by DCP. The nearest existing `.opencode`
directory wins, exactly like the plugin's `findOpencodeDir`.

Test/development overrides read by the service:

- `OPENCHAMBER_DCP_STORAGE_DIR` — DCP state directory
- `OPENCHAMBER_DCP_GLOBAL_CONFIG_DIR` — directory containing the global
  `dcp-rc.jsonc|json` (used by tests/smoke; the OpenChamber host does not pass
  this variable in normal operation)
- `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `OPENCODE_CONFIG_DIR` are honored when
  present, but the host copies only a small environment to the service. Treat a
  custom `XDG_*` or `OPENCODE_CONFIG_DIR` as a known limitation.

## Project mode semantics

DCP 4.3 has three modes:

- `Off` — `enabled: false`
- `Free` — `enabled: true` and `passiveMode: false` (default)
- `Passive` — `enabled: true` and `passiveMode: true`

Passive suppresses every nudge; the compress tool stays available, and
deduplication / error purging follow their own `strategies.*.enabled` settings
in both Free and Passive.

The passive recipe writes `enabled: true` and `passiveMode: true`; Free writes
`passiveMode: false`. If the effective config is disabled, the write also sets
`enabled: true`. `enabled: false` is displayed as Off but the toggle deliberately
does not write it.

DCP 4.3 replaced the old `manualMode` object with the top-level `passiveMode`
key. A stale `manualMode` block is an unknown key to the plugin; the extension
ignores it too and leaves it untouched.

Writes go to the existing project `.jsonc`/`.json`, otherwise a new
`.opencode/dcp-rc.jsonc` (creating `.opencode` if no ancestor has one). Use
`jsonc-parser`'s `modify` + `applyEdits` so comments and unrelated keys survive.
Never rewrite a project config that failed to parse; the service returns 409 and
the panel disables the button.

### Critical caveats

1. **DCP caches config at plugin startup.** The button changes the project
   default for new sessions after OpenCode restarts. A running session keeps its
   current behavior.
2. **Each session can persist its own `/dcp passive` override.** The persisted
   session value overrides the project default, including after a restart. The
   panel detects the mismatch, shows `passive session` / `free session` in the
   Session header, and tells the user to run `/dcp passive on|off` or
   `/dcp passive reset` to apply the project mode to that session immediately.
   The extension cannot invoke DCP's RPC or those commands.
3. The service **writes** the project config. This is a behavior change from
   the original read-only extension and must stay documented in the README.
4. A comments-only config file is how DCP writes its default global config.
   Treat it as empty, not as a parse error; `jsonc-parser` reports it as
   `undefined` with an error.

## Panel behavior

- The rail panel mounts the Project section only when `ctx.directory` is known.
  `host.onDirectory` updates it on project changes; `onReady` supplies the
  initial directory.
- The compact status surface has no button. It prefixes `passive` or `disabled`
  in its subtitle so missing/stale stats are explained.
- After a successful mode write, the panel shows a toast and a persistent
  "new sessions use X mode after OpenCode restarts" notice.
- `syncStatusHeight` calls `host.setHeight`; the Work Status contribution
  declares `height: 84` as its initial height.

## Dependency/build pitfalls

- Import JSONC APIs from `jsonc-parser/lib/esm/main.js`, **not** the package
  root. Bun's Node service bundle leaves the UMD build's dynamic
  `require("./impl/format")` calls unresolved, which crashes the service at
  startup. The ESM entry bundles correctly.
- The panel imports `ProjectStatus` as a type only, so `service/config.ts` and
  its `jsonc-parser` dependency are not pulled into the browser bundle.
- The service process is not OS-sandboxed. The manifest only grants the
  `service` capability; the host approval dialog already warns that a service
  runs with the user's full access.

## Release

Bump `version` in `package.json`, run the full command set above, commit the
rebuilt `panel/main.js` and `service/main.js`, and push. Git installs offer the
update when Settings → Extensions is opened. Do not commit `node_modules` or
temporary panel harnesses.
