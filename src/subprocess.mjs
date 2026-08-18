// dsh-worlds subprocess engine: implements the `ctx.subprocess` spawn surface
// over a Docker container. Contract: packages/subprocess/subprocess/src/{index,types}.ts
import { request } from 'node:http'
import { PassThrough, Writable } from 'node:stream'
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
 * Wrap argv so the child leads its own process group, and record that pgid.
 * `setsid` makes the shell a session leader (pgid == pid); `exec "$@"` then
 * replaces it in place, so the recorded pid IS the group leader. That is what
 * makes termination tree-scoped rather than child-only.
 */
export function wrapArgv(argv, pidFile) {
  return ['setsid', 'sh', '-c', `echo $$ > ${q(pidFile)}; exec "$@"`, 'sh', ...argv]
}

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
      stdin: spec.stdio.stdin === 'pipe' ? new Writable({
        write(chunk, _enc, cb) {
          if (state.socket) state.socket.write(chunk)
          cb()
        },
        final(cb) { state.socket?.end(); cb() },
      }) : undefined,
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
    const wantStdin = spec.stdio.stdin === 'pipe' || typeof spec.stdio.stdin === 'object'

    const created = await this.docker.exec_create(this.id, {
      Cmd: wrapArgv([...spec.argv], pidFile),
      WorkingDir: spec.cwd ?? this.defaultCwd,
      Env: toDockerEnv(spec.env),
      AttachStdin: wantStdin,
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
      if (typeof spec.stdio.stdin === 'object') {
        req.on('socket', () => {})
        setImmediate(() => {
          state.socket?.write(spec.stdio.stdin.data)
          state.socket?.end()
        })
      }
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
    await this.#sh(`rm -f ${q(pidFile)}`)

    // Docker reports signal deaths as 128+signum.
    const SIGNALS = { 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM' }
    if (exitCode !== null && exitCode > 128 && SIGNALS[exitCode - 128]) {
      return { exitCode: null, signal: SIGNALS[exitCode - 128] }
    }
    return { exitCode, signal: null }
  }

  /** SIGTERM -> graceMs -> SIGKILL, applied to the process GROUP. */
  #terminate(state, pidFile, graceMs) {
    if (state.terminating || state.exited) return
    state.terminating = true
    const killGroup = (sig) => this.#sh(`P=$(cat ${q(pidFile)} 2>/dev/null) && [ -n "$P" ] && kill -${sig} -"$P" 2>/dev/null`).catch(() => {})
    killGroup('TERM')
    const timer = setTimeout(() => { if (!state.exited) killGroup('KILL') }, graceMs)
    timer.unref?.()
  }

  /** True when the whole tree is gone; false if the signal aborts first. */
  async #waitForExit(state, pidFile, signal) {
    while (!signal?.aborted) {
      const r = await this.#sh(`P=$(cat ${q(pidFile)} 2>/dev/null); [ -n "$P" ] && kill -0 -"$P" 2>/dev/null && echo alive || echo gone`)
      if (r.stdout.trim() === 'gone') return true
      await new Promise((r2) => setTimeout(r2, 50))
    }
    return false
  }
}
