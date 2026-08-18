// PTY support over Docker's hijacked exec connection.
// Contract: SubprocessTerminalHandle in packages/subprocess/subprocess/src/types.ts
//
// Two things differ from the piped spawn path:
//  1. `Tty: true` makes Docker emit RAW bytes -- the 8-byte stream framing is
//     absent, so demux() must NOT be applied here.
//  2. The connection must be hijacked (Connection: Upgrade) to carry input.
import { request } from 'node:http'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** /proc/<pid>/stat field 8 is tpgid: the controlling terminal's foreground pgid. */
export const TPGID_FIELD = 8

/**
 * Parse tpgid out of a /proc/<pid>/stat line. The comm field is parenthesised
 * and may itself contain spaces or parens, so fields are counted AFTER the
 * final ')' rather than by naive whitespace splitting.
 */
export function parseTpgid(statLine) {
  const close = statLine.lastIndexOf(')')
  if (close === -1) return undefined
  const rest = statLine.slice(close + 2).trim().split(/\s+/)
  // After comm, rest[0] is state (field 3); tpgid is field 8 -> rest[8-3] = rest[5]
  const tpgid = Number(rest[5])
  return Number.isFinite(tpgid) && tpgid > 0 ? tpgid : undefined
}

/** Process state char (field 3) — 'S' = interruptible sleep, the tty-read state. */
export function parseState(statLine) {
  const close = statLine.lastIndexOf(')')
  if (close === -1) return undefined
  return statLine.slice(close + 2).trim().split(/\s+/)[0]
}

export class DockerTerminal {
  constructor(docker, containerId) {
    this.docker = docker
    this.id = containerId
  }

  async #sh(script) {
    return this.docker.exec(this.id, ['sh', '-c', script])
  }

  /** Allocate a PTY and start one owned process session. */
  async spawn(spec) {
    const pidFile = `/tmp/.dsh-worlds-tty-${randomUUID()}.pid`
    const cwd = spec.cwd
    await this.#sh(`mkdir -p ${q(cwd)}`)

    const execId = await this.docker.exec_create(this.id, {
      Cmd: ['sh', '-c', `echo $$ > ${q(pidFile)}; exec "$@"`, 'sh', ...spec.argv],
      WorkingDir: cwd,
      Env: Object.entries(spec.env ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`),
      Tty: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    })

    const output = new PassThrough()
    const state = { pid: -1, exited: false, socket: null, containerPid: null }
    let resolveDone, rejectDone
    const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej })
    done.catch(() => {})

    // Hijack the connection: Upgrade makes node emit 'upgrade' with the raw socket.
    await new Promise((resolveAttach, rejectAttach) => {
      const req = request(
        {
          socketPath: this.docker.socketPath,
          method: 'POST',
          path: `/exec/${execId}/start`,
          headers: {
            'content-type': 'application/json',
            connection: 'Upgrade',
            upgrade: 'tcp',
          },
        },
        (res) => {
          // Docker answered without upgrading (older daemons): the response
          // body is still the raw tty stream.
          state.socket = res.socket
          res.on('data', (c) => output.write(c))
          res.on('end', () => this.#settle(state, execId, output, resolveDone))
          res.on('error', rejectDone)
          resolveAttach()
        },
      )
      req.on('upgrade', (_res, socket, head) => {
        state.socket = socket
        if (head?.length) output.write(head)
        socket.on('data', (c) => output.write(c))
        socket.on('end', () => this.#settle(state, execId, output, resolveDone))
        socket.on('error', rejectDone)
        resolveAttach()
      })
      req.on('error', (e) => { rejectAttach(e); rejectDone(e) })
      req.write(JSON.stringify({ Detach: false, Tty: true }))
      req.end()
    })

    await this.resize(execId, spec.rows, spec.cols)

    // Container-side pid of the session leader, for signalling and /proc reads.
    for (let i = 0; i < 40 && state.containerPid === null; i++) {
      const r = await this.#sh(`cat ${q(pidFile)} 2>/dev/null`)
      const pid = Number(r.stdout.trim())
      if (Number.isFinite(pid) && pid > 0) state.containerPid = pid
      else await new Promise((r2) => setTimeout(r2, 25))
    }
    const info = await this.docker.exec_inspect(execId)
    state.pid = info?.Pid ?? state.containerPid ?? -1

    const self = this
    return {
      get pid() { return state.pid },
      output,
      done,
      async write(data) {
        if (state.exited) return
        state.socket?.write(data)
      },
      async inspectForeground() {
        return self.#inspectForeground(state)
      },
      async signalForeground(signal) {
        return self.#signalForeground(state, signal)
      },
      async terminate() {
        return self.#terminate(state, spec.graceMs, execId, output, resolveDone)
      },
      resize: (rows, cols) => self.resize(execId, rows, cols),
    }
  }

  async #settle(state, execId, output, resolveDone) {
    if (state.exited) return
    state.exited = true
    output.end()
    const info = await this.docker.exec_inspect(execId)
    const code = info?.ExitCode ?? null
    const SIGNALS = { 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM', 1: 'SIGHUP' }
    if (code !== null && code > 128 && SIGNALS[code - 128]) {
      resolveDone({ exitCode: null, signal: SIGNALS[code - 128] })
    } else {
      resolveDone({ exitCode: code, signal: null })
    }
  }

  /** POST /exec/{id}/resize?h=<rows>&w=<cols> */
  async resize(execId, rows, cols) {
    const { api } = await import('./docker.mjs')
    await api(this.docker.socketPath, 'POST', `/exec/${execId}/resize?h=${rows}&w=${cols}`, undefined, { raw: true })
  }

  async #inspectForeground(state) {
    if (state.containerPid === null || state.exited) return undefined
    const r = await this.#sh(`cat /proc/${state.containerPid}/stat 2>/dev/null`)
    if (!r.stdout.trim()) return undefined
    const pgid = parseTpgid(r.stdout)
    if (pgid === undefined) return undefined
    // Heuristic: the group is treated as waiting on input when its leader sits
    // in interruptible sleep. A blocked read and an idle sleep are
    // indistinguishable from /proc alone -- documented, not hidden.
    const leader = await this.#sh(`cat /proc/${pgid}/stat 2>/dev/null`)
    const inputWaiting = leader.stdout.trim() ? parseState(leader.stdout) === 'S' : false
    return { processGroupId: pgid, inputWaiting }
  }

  async #signalForeground(state, signal) {
    const fg = await this.#inspectForeground(state)
    if (fg === undefined) throw new Error('no foreground process group')
    await this.#sh(`kill -${signal.replace('SIG', '')} -${fg.processGroupId} 2>/dev/null || kill -${signal.replace('SIG', '')} ${fg.processGroupId} 2>/dev/null`)
    return fg.processGroupId
  }

  async #terminate(state, graceMs, execId, output, resolveDone) {
    if (state.exited || state.containerPid === null) {
      state.socket?.end()
      return
    }
    const pid = state.containerPid
    const killTree = (sig) => this.#sh(`
kt() { for c in $(ps -o pid,ppid 2>/dev/null | awk -v p="$1" '$2==p{print $1}'); do kt "$c" "$2"; done; kill -"$2" "$1" 2>/dev/null; }
kt ${pid} $1`.replace('$1', sig)).catch(() => {})
    await killTree('TERM')
    const deadline = Date.now() + graceMs
    while (Date.now() < deadline && !state.exited) {
      const r = await this.#sh(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)
      if (r.stdout.trim() === 'gone') break
      await new Promise((r2) => setTimeout(r2, 50))
    }
    if (!state.exited) {
      const r = await this.#sh(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)
      if (r.stdout.trim() === 'alive') await killTree('KILL')
    }
    state.socket?.end()
    await this.#settle(state, execId, output, resolveDone)
  }
}
