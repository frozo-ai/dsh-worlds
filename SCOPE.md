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
3. ✅ **`subprocess.spawn`** — 22 live checks. resolveExecutable, collect +
   pipe stdio, batch stdin, cwd/env, exit codes, tree-scoped terminate
   escalation, abort signal, waitForExit
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

## Step 3 status — DONE (22 live checks)

`src/collect.mjs` — **done, 11 unit checks.** Offset-based non-consuming reads,
tail window with `lossy` reporting, spill retained under cap and discarded when
the whole-stream cap is exceeded, UTF-8 split across chunks.

`src/subprocess.mjs` — **partially working.** Verified live: `resolveExecutable`
(PATH + absolute + rejections), streaming exec with incremental demux, collect
mode, exit code 0.

**Resolved.** busybox `setsid` forks and returns 0, swallowing the child's exit
code (and has no `-w` flag). Fix: drop `setsid` entirely and `exec "$@"` in place
so the recorded pid IS the process and its status propagates unchanged.

Without a process group to signal, termination walks the process tree instead —
a recursive `ps -o pid,ppid` walk that signals children depth-first before the
parent, so a parent cannot reap-and-orphan its descendants mid-walk. Verified:
`sh -c 'sleep 30 & sleep 30'` leaves zero orphans after `terminate()`.

**Also resolved:** batch stdin (`{ data }`) is staged as a container-side file and
redirected in, avoiding Docker's hijacked connection entirely.

**Still not implemented:** `stdin: 'pipe'` (ongoing protocol writes) genuinely
needs the hijacked connection. It rejects `done` with a clear message rather than
hanging. This is what an LSP transport would need, so step 5 depends on it.

## Step 6 — TS/Cordis adapter (WRITTEN, NOT YET VERIFIED)

`adapter/` binds the tested JS engines to the real seams:

| File | Role |
|---|---|
| `world.ts` | `DockerWorld` service (`ctx.world`) — container lifecycle. Reuses a **named** container across restarts; `stop()` deliberately leaves it running |
| `fs.ts` | `DockerFileSystem extends FileSystem` → registers `ctx.fs` |
| `subprocess.ts` | `DockerSubprocessRuntime extends SubprocessRuntime` → registers `ctx.subprocess` |
| `engines.d.ts` | ambient types for the zero-dep `.mjs` engines |
| `cordis.yml` | overlay patch that mounts all three |

The adapters are thin by design: branding (`FsTargetKey`/`FsVersion`), typed
`FsError` mapping, and abort checks live here; container mechanics stay in the
94-check engines.

`spawnTerminal` throws a clear "not implemented" — a PTY needs the hijacked exec
connection (step 5). Keep `dsh-terminal` on the local provider until then.

### VERIFICATION STATUS: TYPECHECKS CLEAN

`pnpm install` + `pnpm run build:lib:host` completed in the dsh checkout, and
the adapter now compiles clean against the real `@deepseek-ai/dsh-fs`,
`@deepseek-ai/dsh-subprocess`, and `@deepseek-ai/cordis` declarations:

```sh
tsc -p adapter/tsconfig.json    # no errors
```

Three errors were found and fixed on the first pass:
1. `Service` has **no `start()`/`stop()` lifecycle** — Cordis runs a method keyed
   by the `Service.init` symbol after construction instead. Both overrides were
   wrong; `start` became `async [Service.init]()` and `stop` was removed entirely
   (registering a `ctx.effect()` disposer would unwind on unload and destroy the
   container, i.e. exactly the state this provider exists to preserve).
2. + 3. an implicit `any` in the `listDir` map callback.

Notably the two failures I predicted — the `FsError` code cast and the
`ctx.inject` signature — both typechecked as written.

### RUNTIME VERIFIED — the agent wrote into the container

```sh
DEEPSEEK_BASE_URL=<openai-compatible> DSH_MODEL=<model> \
  pnpm dsh --profile headless --patch /abs/path/to/adapter/cordis.yml \
  "Write hello-from-container into proof.txt, then cat it"
```

Result: the agent's `write` went through `ctx.fs` -> DockerFileSystem -> the
container. Verified from outside:

| Check | Result |
|---|---|
| file inside container | `/Users/.../deepseek-harness/proof.txt` |
| contents | `hello-from-container` |
| file on host | **absent** |

Two runtime bugs that only a real boot could find:

1. **`#private` fields break through cordis's service Proxy** —
   `Cannot read private member #engine from an object whose class did not
   declare it`. Every tool call failed. All `#private` fields in the adapters
   are now ordinary `_`-prefixed properties. Typecheck could never have caught
   this.
2. The overlay must **disable** `fs-sandbox` and `subprocess` (found via
   `--dump-config`), since cordis allows one implementation per service.

### Known gaps after first boot

- ~~Bash does not run~~ **FIXED.** The seam's own doc gave the answer:
  "Containers, microVMs, and remote execution replace the surrounding capability
  seam instead; this service shares the host kernel and filesystem." So the fix
  is not to fake a sandbox but to retire host confinement: disable `sandbox`,
  `sandbox-policy`, `bash-sandbox`, `pwsh-sandbox`, and swap in
  `@deepseek-ai/dsh-bash-local`, which spawns through `ctx.subprocess` and
  therefore lands in the container.

  `permission-presets` then refuses to compose over an unconfined executor
  ("presets bundle a sandbox mode"), so it is disabled too.
  **TRADE-OFF:** per-call sandbox modes (read-only / workspace-write) are no
  longer enforced at the bash layer. The container is the boundary now, which is
  coarser — it fences the host, not the workspace.

  Verified: agent ran bash and reported `Alpine Linux 3.24.1`, kernel
  `linuxkit`, `aarch64`, hostname = the container id — from a macOS host.
- **Path mirroring**: dsh passes the *host* workspace path as cwd, and the
  provider creates that path inside the container. Path-transparent and it
  works, but real workspace access needs a bind mount (`binds` in WorldConfig).
- ~~`spawnTerminal` unimplemented~~ **DONE — step 5 complete.**


## DURABILITY DEMO — PROVEN

Run 1 (harness process A):
```
bash: mkdir -p /srv && echo session-state-v1 > /srv/state.txt
      && (nohup sleep 900 &) && cat /srv/state.txt && ps | grep -c sleep
  -> session-state-v1
     2
```
Process A exits. Checked from outside: state file intact, 1 sleep alive.

Run 2 (harness process B — a brand new process, same world):
```
bash: cat /srv/state.txt; ps -o args | grep '[s]leep 900'
  -> session-state-v1
     sleep 900        <-- started by a harness that no longer exists
```

This is the counter-example to `packages/terminal/terminal/README.md`:
> "Sessions are process-local and are not restored after a harness restart."

No CRIU, no microVM. A Docker container simply outlives its client, and the
world is addressed by a stable container name.

## Two more runtime findings

4. **cwd must be created before exec.** dsh passes the HOST workspace path as
   `WorkingDir`; Docker fails the exec outright when it does not exist in the
   container. The subprocess provider now `mkdir -p`s it.
5. **Alpine has no `bash`.** The bash executor invokes `bash` by name and
   busybox ships only `sh`. `DockerWorld` now provisions `bash` + `procps`
   (apk or apt) when the image lacks them, and fails loudly if it cannot.


## Step 5 — PTY (`spawnTerminal`) DONE, 17 live checks

`src/terminal.mjs`. Two things differ from the piped spawn path:
1. `Tty: true` makes Docker emit **raw** bytes — the 8-byte stream framing is
   absent, so `demux()` must NOT be applied.
2. The connection must be **hijacked** (`Connection: Upgrade`) to carry input.
   Both the `upgrade` and plain `response` paths are handled, since older
   daemons answer without upgrading.

Foreground facts come from `/proc/<pid>/stat` field 8 (tpgid) read inside the
container. The parser counts fields *after* the final `)` because `comm` may
itself contain spaces and parentheses — tested with `(weird (proc) name)`.

**Documented limit:** `inputWaiting` is a heuristic — the group is reported as
waiting when its leader sits in interruptible sleep (`S`). A blocked tty read
and an idle sleep are indistinguishable from `/proc` alone.

Verified live: real tty (`test -t 0`, `/dev/pts`), interactive round trip,
`resize` -> `stty size` 40x132, `inspectForeground` -> pgid, and
`signalForeground(SIGINT)` killing the foreground group **while the session
shell survives** — correct job-control semantics.

### End-to-end through dsh

Overlay additions: `terminal`, `terminal-bash`, `tool-terminal` (the headless
profile omits them). Two blockers found:
- `terminal-bash` hard-requires `ctx.sandboxPolicy`, so `sandbox-policy` must
  stay ENABLED — it only resolves policy, it enforces nothing.
- Tools gate availability on the sandbox mode; the default `workspace-write`
  hides the terminal tool. Forced to `danger-full-access`, which is the honest
  mode: host confinement is meaningless when the process is not on this kernel.

Chain proven — `terminal-bash/src/index.ts:113` is
`spec => ctx.subprocess.spawnTerminal(spec)`, and the agent's `terminal_open`
returned `/dev/pts/0` + Alpine 3.24.1 from a macOS host.
