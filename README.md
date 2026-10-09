# DCP RC Stats for OpenChamber

An OpenChamber extension that shows what
[DCP RC](https://github.com/royalcat/opencode-dcp-rc) is saving you: the
compression stats of the open session, the active compressions, and all-time
totals — in the extensions rail panel and in the chat's Work Status panel.

```
Session                                  All-time
─────────────────────────                ─────────────────────────
Tokens in|out   ~642K | ~74K              Tokens saved     ~16.5M
Ratio           9:1                       Tools pruned     278
Time            9.9 s                     Messages pruned  12143
Messages        368                       Sessions         149
Tools           463                       Summary requests 116 (~14.5M in | ~1.1M out)
Summary requests 0 (0 provider, 0 estimated)
Request in|out  ~0 | ~0
Request cache   ~0 read | ~0 write
Request reason  ~0

Active compressions
Block #12  8:1
~118K → ~15K · 87 tools · 41 msgs · 2h ago
```

## Requirements

- OpenChamber **2.0.4** or newer (web or desktop; VS Code and mobile do not
  load extensions).
- The [`@royalcat/opencode-dcp-rc`](https://github.com/royalcat/opencode-dcp-rc)
  plugin installed in OpenCode (the extension reads its state files).

## Install

In OpenChamber, open **Settings → Extensions**, paste
`https://github.com/royalcat/openchamber-dcp-rc-stats`, and click **Add**.
Approve the dialog — it includes **Run a local service**, which is what reads
the stats. The DCP icon then appears on the extensions rail; the "DCP" section
is available in the chat's Work Status panel section list.

Git installs update themselves: bump `version` in `package.json`, rebuild, and
push; OpenChamber offers the update the next time Settings → Extensions is
opened. Add `#v0.1.0` or `#main` to the URL to pin a tag or branch.

To hack on the extension, add the absolute path of a checkout instead: a folder
install runs straight from that folder and never updates on its own.

## What it reads

The extension's local service reads the state files DCP RC persists per
session:

```
~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
```

It reproduces the numbers of `/dcp stats` (`buildStatsReport` and
`loadAllSessionStats` from the plugin) — tokens saved, summary size, ratio,
compression time, pruned messages and tools, hidden summary request usage, and
all-time totals. No OpenCode or OpenChamber API is called, so the panel works
on instances protected with a UI password.

The service is a small Node process on `127.0.0.1` started by OpenChamber on
first use; the panel reaches it only through the host's loopback proxy. It
reads the DCP storage directory and nothing else. Parsed files are cached by
mtime, so the all-time scan stays cheap after the first request.

## Surfaces

- **Rail panel** — the full report, refreshed every four seconds while
  visible, on session change, and when a turn finishes.
- **Work Status section** — a compact card (saved tokens, ratio, block count,
  all-time total) that you can hide or move in the Work Status panel like the
  built-in sections.

## Limitations

- Read-only. Toggling manual mode or asking DCP to compress from the panel
  would need the plugin's RPC, which is not reachable from extensions.
- The context breakdown (system / user / assistant / tools) is computed from
  live messages inside OpenCode and is not persisted; it is not shown.
- The storage directory is resolved from `$HOME`. If OpenCode runs with a
  custom `XDG_DATA_HOME`, the service cannot see it and the panel says the
  state folder was not found.

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run test        # node:test aggregation tests
bun run build       # panel/main.js (IIFE) + service/main.js (ESM)
bun run smoke       # starts the built service against a temp dir
```

OpenChamber never compiles an extension: `panel/main.js` and `service/main.js`
are built and committed. Rebuild and commit them with every change.

The aggregation in `service/stats.ts` mirrors the plugin's
`buildStatsReport` / `loadAllSessionStats`; the unit tests pin the rules and
the layout of the payload the panel consumes.

## License

AGPL-3.0-or-later. DCP RC is AGPL-3.0-or-later too.
