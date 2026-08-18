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
| Easy — pure logic | `resolve` `processPath` `fileUrl` `contains` | path math, no daemon call |
| Easy | `readText` `readBytes` `listDir` `stat` `lstat` | `GET /containers/{id}/archive` (tar) or `exec` |
| Medium | `writeText` `editText` | `PUT /containers/{id}/archive`, atomic-write semantics |
| Medium | `streamText` | chunked archive read, backpressure |

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

1. ✅ **Docker Engine API client + stream demux** — done, 11 tests passing
2. `fs` provider over the archive API — biggest win per line, unblocks all file tools
3. `subprocess.spawn` pipe + collect — unblocks Bash
4. `terminate` / `waitForExit` tree semantics
5. `spawnTerminal` PTY — the hard one, unblocks persistent terminals + LSP

Stop after 3 and you already have a working remote Bash + file world. That's the
demo: **kill the harness, restart, resume the session — the container still holds
cwd, env vars, and running background processes.** A Docker container outlives its
client by default, so v0 needs no CRIU at all.

## Status

Step 1 complete and tested. Steps 2–5 are the real project.

**Blocker on this machine:** Docker Desktop is uninstalled — `/usr/local/bin/docker`
is a broken symlink to a deleted `/Applications/Docker.app`, and `/_ping` on the
socket returns `000`. Tests run against a fake daemon speaking the real wire
protocol, so the client code is exercised; it has **not** been run against a real
Docker daemon yet. Install Docker (or OrbStack/Colima) and `npm run verify` will
prove it end-to-end.
