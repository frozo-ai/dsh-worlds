// dsh-worlds subprocess engine: implements the `ctx.subprocess` spawn surface
// over a Docker container. Contract: packages/subprocess/subprocess/src/{index,types}.ts
import { request } from 'node:http'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { demux } from './docker.mjs'
import { CollectBuffer } from './collect.mjs'

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** Env object -> Docker's ["K=V"] form; undefined values are tombstones. */
export function toDockerEnv(env) {
  if (!env) return []
  return Object.entries(env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
}

/**
 * Wrap argv so the root pid is recorded, then `exec` replaces the shell in
 * place — so the recorded pid IS the process and its exit status propagates
 * unchanged.
 *
 * Deliberately NOT using `setsid`: busybox's setsid forks and returns 0,
 * swallowing the child's exit code (and it has no `-w` flag to wait). Without
 * a process group to signal, termination walks the process tree instead —
 * see {@link KILL_TREE_SH}.
 */
export function wrapArgv(argv, pidFile, stdinFile) {
  const redirect = stdinFile ? ` < ${q(stdinFile)}` : ''
  return ['sh', '-c', `echo $$ > ${q(pidFile)}; exec "$@"${redirect}`, 'sh', ...argv]
}

/**
 * Recursive tree kill using only busybox primitives. Signals children
 * depth-first before the parent, so a parent cannot reap-and-orphan its
 * descendants mid-walk. `ps -o pid,ppid` is available in busybox.
 */
export const KILL_TREE_SH = `
kt() {
  for c in $(ps -o pid,ppid 2>/dev/null | awk -v p="$1" '$2==p{print $1}'); do kt "$c" "$2"; done
  kill -"$2" "$1" 2>/dev/null
}
`

/** True when pid or any descendant is still alive. */
export const TREE_ALIVE_SH = `
alive() {
  kill -0 "$1" 2>/dev/null && return 0
  for c in $(ps -o pid,ppid 2>/dev/null | awk -v p="$1" '$2==p{print $1}'); do alive "$c" && return 0; done
  return 1
}
`

export class DockerSubprocess {
  constructor(docker, containerId, defaultCwd = '/workspace') {
    this.docker = docker
    this.id = containerId
    this.defaultCwd = defaultCwd
  }

  async #sh(script) {
    return this.docker.exec(this.id, ['sh', '-c', script])
  }

  /** Resolve an executable inside the container's PATH. */
  async resolveExecutable(command, env) {
    if (command.includes('/') && !command.startsWith('/')) {
      throw new Error(`relative path with separators is not resolvable: ${command}`)
    }
    const envPrefix = toDockerEnv(env).map((e) => `${q(e.split('=')[0])}=${q(e.split('=').slice(1).join('='))}`).join(' ')
    const script = command.startsWith('/')
      ? `[ -x ${q(command)} ] && printf %s ${q(command)}`
      : `${envPrefix} command -v ${q(command)}`
    const r = await this.#sh(script)
    const path = r.stdout.trim()
    if (r.exitCode !== 0 || !path) throw new Error(`executable not found: ${command}`)
    return path
  }

  /**
   * Start a managed process. Returns a live handle SYNCHRONOUSLY — the async
   * exec setup runs behind it, matching the seam's contract.
   */
  spawn(spec) {
    const pidFile = `/tmp/.dsh-worlds-${randomUUID()}.pid`
    const stdoutCollect = typeof spec.stdio.stdout === 'object' ? new CollectBuffer(spec.stdio.stdout) : null
    const stderrCollect = typeof spec.stdio.stderr === 'object' ? new CollectBuffer(spec.stdio.stderr) : null
    const stdoutPipe = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
    const stderrPipe = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined

    const state = { pid: -1, exited: false, terminating: false, socket: null }
    let resolveDone, rejectDone
    const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej })
    // The caller may only await `done`; never surface an unhandled rejection.
    done.catch(() => {})

    const handle = {
      get pid() { return state.pid },
      stdin: undefined,
      stdout: stdoutPipe,
      stderr: stderrPipe,
      collected: {
        ...(stdoutCollect ? { stdout: { readFrom: (n) => stdoutCollect.readFrom(n) } } : {}),
        ...(stderrCollect ? { stderr: { readFrom: (n) => stderrCollect.readFrom(n) } } : {}),
      },
      done,
      terminate: () => this.#terminate(state, pidFile, spec.graceMs),
      waitForExit: (signal) => this.#waitForExit(state, pidFile, signal),
      // engine extras (not part of the seam contract)
      _collect: { stdout: stdoutCollect, stderr: stderrCollect },
    }

    this.#run(spec, pidFile, { state, stdoutCollect, stderrCollect, stdoutPipe, stderrPipe })
      .then(resolveDone, rejectDone)

    if (spec.signal) {
      if (spec.signal.aborted) handle.terminate()
      else spec.signal.addEventListener('abort', () => handle.terminate(), { once: true })
    }
    return handle
  }

  async #run(spec, pidFile, io) {
    const { state, stdoutCollect, stderrCollect, stdoutPipe, stderrPipe } = io
    if (spec.stdio.stdin === 'pipe') {
      throw new Error(
        "stdin: 'pipe' is not implemented yet — it needs Docker's hijacked connection. " +
        "Use stdin: { data } (batch) or 'ignore'.",
      )
    }
    // Batch stdin is staged as a container-side file and redirected in, which
    // avoids hijacking the exec connection entirely.
    let stdinFile
    if (typeof spec.stdio.stdin === 'object') {
      stdinFile = `${pidFile}.stdin`
      await this.docker.putArchiveFile(this.id, '/tmp', stdinFile.split('/').pop(), Buffer.from(spec.stdio.stdin.data, 'utf8'))
    }

    // dsh passes the HOST workspace path as cwd; that path does not exist in a
    // fresh container, and Docker fails the exec outright when WorkingDir is
    // missing. Create it so the container world mirrors the host layout.
    const cwd = spec.cwd ?? this.defaultCwd
    await this.#sh(`mkdir -p ${q(cwd)}`)

    const created = await this.docker.exec_create(this.id, {
      Cmd: wrapArgv([...spec.argv], pidFile, stdinFile),
      WorkingDir: cwd,
      Env: toDockerEnv(spec.env),
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
    })

    const exitCode = await new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.docker.socketPath,
          method: 'POST',
          path: `/exec/${created}/start`,
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          state.socket = res.socket
          let carry = Buffer.alloc(0)
          res.on('data', (chunk) => {
            const { stdout, stderr, rest } = demux(Buffer.concat([carry, chunk]))
            carry = rest
            if (stdout.length) {
              stdoutCollect?.push(stdout)
              stdoutPipe?.write(stdout)
              if (spec.stdio.stdout === 'inherit') process.stdout.write(stdout)
            }
            if (stderr.length) {
              stderrCollect?.push(stderr)
              stderrPipe?.write(stderr)
              if (spec.stdio.stderr === 'inherit') process.stderr.write(stderr)
            }
          })
          res.on('end', async () => {
            stdoutPipe?.end()
            stderrPipe?.end()
            state.exited = true
            const info = await this.docker.exec_inspect(created)
            resolve(info?.ExitCode ?? null)
          })
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      req.write(JSON.stringify({ Detach: false, Tty: false }))
      req.end()
    })

    // Persist spill files inside the container so paths are world-local.
    for (const [name, buf] of [['stdout', stdoutCollect], ['stderr', stderrCollect]]) {
      const complete = buf?.completeBytes()
      if (complete && buf.total > buf.tail.length) {
        const path = `${pidFile}.${name}.spill`
        await this.docker.putArchiveFile(this.id, '/tmp', path.split('/').pop(), complete)
        buf.spillPath = path
      }
    }
    await this.#sh(`rm -f ${q(pidFile)}${stdinFile ? ' ' + q(stdinFile) : ''}`)

    // Docker reports signal deaths as 128+signum.
    const SIGNALS = { 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM' }
    if (exitCode !== null && exitCode > 128 && SIGNALS[exitCode - 128]) {
      return { exitCode: null, signal: SIGNALS[exitCode - 128] }
    }
    return { exitCode, signal: null }
  }

  /** SIGTERM -> graceMs -> SIGKILL, applied depth-first to the whole tree. */
  #terminate(state, pidFile, graceMs) {
    if (state.terminating || state.exited) return
    state.terminating = true
    const killTree = (sig) =>
      this.#sh(`${KILL_TREE_SH} P=$(cat ${q(pidFile)} 2>/dev/null); [ -n "$P" ] && kt "$P" ${sig}`).catch(() => {})
    killTree('TERM')
    const timer = setTimeout(() => { if (!state.exited) killTree('KILL') }, graceMs)
    timer.unref?.()
  }

  /** True when the whole tree is gone; false if the signal aborts first. */
  async #waitForExit(state, pidFile, signal) {
    while (!signal?.aborted) {
      const r = await this.#sh(
        `${TREE_ALIVE_SH} P=$(cat ${q(pidFile)} 2>/dev/null); if [ -n "$P" ] && alive "$P"; then echo alive; else echo gone; fi`,
      )
      if (r.stdout.trim() === 'gone') return true
      await new Promise((r2) => setTimeout(r2, 50))
    }
    return false
  }
}
