# dsh-worlds — implementation scope

Measured against the real Service Definitions in the dsh repo, not guesses.

## Why two plugins move everything

`packages/e2b/README.md`:
> The existing `dsh-bash-local`, `dsh-terminal-bash`, and `dsh-lsp-stdio` need no
> E2B-specific forks. They delegate every execution-world operation to `ctx.fs`
> and `ctx.subprocess`.

Implement those two seams → Bash, persistent PTY terminals, LSP, and every file
tool relocate into the container automatically.

## Size benchmark (measured with wc -l)

| Reference implementation | Lines |
|---|---|
| `subprocess-local` + `fs-local` (local) | 2,601 |
| `subprocess-e2b` + `fs-e2b` (remote — closest prior art) | 2,447 |

**A complete Docker provider is realistically ~2,000–2,500 lines of systems code.**
Not a weekend. The remote one is the honest benchmark because it faces the same
problems: no direct process access, everything over a transport.

## Interface inventory

### `ctx.fs` — 12 abstract methods
`resolve` `processPath` `fileUrl` `contains` `stat` `lstat` `readText`
`streamText` `readBytes` `listDir` `writeText` `editText`

| Difficulty | Methods | Docker mechanism |
|---|---|---|
| ✅ Easy — pure logic | `resolve` `processPath` `fileUrl` `contains` | path math, no daemon call |
| ✅ Easy | `readText` `readBytes` `listDir` `stat` `lstat` | `exec` + base64 (output is not ARG_MAX-bound) |
| ✅ Medium | `writeText` `editText` | `PUT .../archive` to temp name + `mv` = atomic publication |
| ✅ Medium | `streamText` | chunked decode |

All 12 implemented in `src/fs.mjs` (236 lines) with the full `FsErrorCode`
taxonomy: `FS_NOT_FOUND` `FS_NOT_DIRECTORY` `FS_NOT_TEXT` `FS_NOT_REGULAR_FILE`
`FS_TOO_LARGE` `FS_STALE_VERSION` `FS_NOT_OBSERVED` `FS_AMBIGUOUS_EDIT`
`FS_EDIT_NOT_FOUND` `FS_IO_ERROR`.

**Not yet done:** the TypeScript/Cordis binding. `DockerFs` implements the seam's
method surface and semantics; registering as `ctx.fs` needs a thin TS adapter
extending `FileSystem` from `@deepseek-ai/dsh-fs`, built inside the dsh monorepo.

### `ctx.subprocess` — 3 abstract methods, rich handles

`resolveExecutable` · `spawn` → `SubprocessHandle` · `spawnTerminal` → `SubprocessTerminalHandle`

| Difficulty | Item | Docker mechanism | Notes |
|---|---|---|---|
| Easy | `resolveExecutable` | `exec command -v` | ✅ client supports today |
| Easy | `spawn` pipe stdio | `exec` + stream demux | ✅ **built & tested** |
| Medium | collect mode | offset-based non-consuming readers + spill files | pure logic, portable from `subprocess-local` |
| Medium | `terminate` SIGTERM→grace→SIGKILL, tree-scoped | `exec kill` / container stop | needs PID namespace care |
| **Hard** | `spawnTerminal` (PTY) | `exec` with `Tty:true`, `POST /exec/{id}/resize` | bidirectional hijacked stream |
| **Hard** | `waitForExit` whole-tree liveness | poll `ps` inside container | no host process tree to observe |
| **Hard** | `SubprocessTerminalForeground` | read `/proc/*/stat` inside container | foreground process-group inspection |

The three Hard rows are the moat. They're also why the vendor's own E2B mapping
is still labelled a POC.

## Build order

1. ✅ **Docker Engine API client + stream demux** — 11 unit + 12 live checks
2. ✅ **`fs` provider — all 12 methods** — 38 live checks. Writes go through
   `PUT /containers/{id}/archive` (minimal USTAR writer, no deps): a shell
   command line is capped by ARG_MAX, so base64-on-argv died at ~200KB.
   Verified byte-identical to 5MB in 217ms.
3. `subprocess.spawn` pipe + collect — unblocks Bash
4. `terminate` / `waitForExit` tree semantics
5. `spawnTerminal` PTY — the hard one, unblocks persistent terminals + LSP

Stop after 3 and you already have a working remote Bash + file world. That's the
demo: **kill the harness, restart, resume the session — the container still holds
cwd, env vars, and running background processes.** A Docker container outlives its
client by default, so v0 needs no CRIU at all.

## Status

Step 1 complete and tested. Steps 2–5 are the real project.

**Verified against real Docker 29.7.2** (Docker Desktop, aarch64) — `npm run verify`,
12/12 live checks. Confirmed: stdout/stderr demux on real framing, non-zero exit
propagation, 48,893 bytes / 5,000 lines intact across arbitrary frame boundaries,
`WorkingDir` honoured, and the durability demo — file state **and** a running
background process both survive discarding the client and reconnecting fresh.

`npm test` (11 checks, fake daemon) stays as the fast no-Docker path.

## Step 3 status (in progress)

`src/collect.mjs` — **done, 11 unit checks.** Offset-based non-consuming reads,
tail window with `lossy` reporting, spill retained under cap and discarded when
the whole-stream cap is exceeded, UTF-8 split across chunks.

`src/subprocess.mjs` — **partially working.** Verified live: `resolveExecutable`
(PATH + absolute + rejections), streaming exec with incremental demux, collect
mode, exit code 0.

**Known blocker:** busybox `setsid` forks and returns 0 instead of propagating
the child's exit code, so a non-zero exit reads as 0. Confirmed: busybox setsid
has no `-w` flag. Fix options, in order of preference:
1. `apk add util-linux` in the image and use `setsid -w` (propagates exit code)
2. Drop `setsid`; run `sh -c 'echo $$ > pidfile; exec "$@"'` and signal the pid
   directly — loses new-process-group scoping, so tree-kill needs `pkill -P` or
   a cgroup instead
3. Use the container's cgroup for tree termination (most robust; most work)

Until this is resolved, exit-code propagation and the tree-termination tests do
not pass. Nothing in step 3 should be considered done.
