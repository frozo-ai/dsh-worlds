# dsh-worlds

**Run the agent's execution world inside a container — so it survives the harness that started it.**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) records this limitation in `packages/terminal/terminal/README.md`:

> "Sessions are process-local and are **not restored after a harness restart**."

The session log is durable. The *computer* the agent was working on is not — the shell dies with the harness, taking your cwd, exported variables, and background processes with it.

`dsh-worlds` fixes that by moving the execution world into a Docker container. No CRIU, no microVMs: a container simply outlives its client.

```
harness process A            harness process B (a different process)
      |                                    |
      +------> [ container: dsh-world ] <--+
                cwd · env · running procs
```

## Why two plugins move everything

From the harness's own architecture docs:

> "The existing `dsh-bash-local`, `dsh-terminal-bash`, and `dsh-lsp-stdio` **need no forks**. They delegate every execution-world operation to `ctx.fs` and `ctx.subprocess`."

Implement those two seams and Bash, persistent PTY terminals, LSP, and every file tool relocate into the container automatically. That is a deliberate architectural gift, and this project is what happens when you take it.

## Status

| Capability | Checks |
|---|---|
| Docker Engine API client + stream demux | 11 unit + 12 live |
| `ctx.fs` — all 12 methods | 38 live |
| Bounded collect buffers (offset-based, non-consuming) | 11 unit |
| `ctx.subprocess` — spawn, tree termination, `waitForExit` | 22 live |
| PTY — `spawnTerminal`, resize, foreground signalling | 17 live |
| **Total** | **111** |

Zero npm dependencies. `node:http`, `node:net`, `node:crypto` only.

## Try it

Requires Docker and a [dsh](https://github.com/deepseek-ai/deepseek-harness) checkout that has been built.

```sh
git clone https://github.com/frozo-ai/dsh-worlds
cd dsh-worlds
npm test              # unit suites, no Docker needed
npm run verify        # live: Docker client
npm run verify:fs     # live: filesystem provider
npm run verify:subprocess
npm run verify:terminal
```

Then mount it into dsh — **edit the absolute paths in `adapter/cordis.yml` first**:

```sh
cd /path/to/deepseek-harness
pnpm dsh --profile headless --patch /abs/path/to/dsh-worlds/adapter/cordis.yml "run: uname -a"
```

## The demo

```sh
# harness A: create state, start a background process, then exit
pnpm dsh --profile headless --patch .../cordis.yml \
  "bash: echo session-state-v1 > /srv/state.txt && (nohup sleep 900 &)"

# harness B: a brand new process, same world
pnpm dsh --profile headless --patch .../cordis.yml \
  "bash: cat /srv/state.txt; ps -o args | grep '[s]leep 900'"
#   -> session-state-v1
#      sleep 900     <-- started by a harness that no longer exists
```

## Honest limits

- **The container is the boundary, not the sandbox seam.** The overlay disables `sandbox`, `bash-sandbox` and `permission-presets`, and forces `danger-full-access`. Per-call sandbox modes (`read-only` / `workspace-write`) are no longer enforced at the bash layer. Host confinement is meaningless for a process that isn't on this kernel — but the container fences the *host*, not the workspace, which is coarser.
- **`stdin: 'pipe'`** (ongoing protocol writes) is not implemented; it rejects loudly rather than hanging. Batch `stdin: { data }` works.
- **`inputWaiting` is a heuristic** — a blocked tty read and an idle sleep are indistinguishable from `/proc` alone.
- **The image must provide `bash`, `ps`, and `base64`.** `DockerWorld` installs `bash`/`procps` via apk or apt when missing, and fails loudly if it can't.
- **Path mirroring:** dsh passes the *host* workspace path as cwd and the provider creates it inside the container. Real workspace access needs a bind mount (`binds` in `WorldConfig`).
- dsh itself is a developer preview with breaking changes; pin versions.

`SCOPE.md` carries the full interface map, size benchmarks, and every bug found along the way.

MIT. Not affiliated with DeepSeek AI.
