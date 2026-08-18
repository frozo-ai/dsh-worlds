// Zero-dependency Docker Engine API client over the unix socket.
// No `docker` CLI required; works against any Engine API >= 1.41.
import { request } from 'node:http'

export const DEFAULT_SOCKET = process.env.DOCKER_HOST_SOCKET ?? '/var/run/docker.sock'

/**
 * One Docker Engine API call.
 * @returns {Promise<{status:number, body:any, raw:Buffer}>}
 */
export function api(socketPath, method, path, body, { raw = false, contentType = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
    const req = request(
      {
        socketPath,
        method,
        path,
        headers: {
          'content-type': contentType,
          ...(payload ? { 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          let parsed
          if (!raw) {
            try {
              parsed = buf.length ? JSON.parse(buf.toString('utf8')) : undefined
            } catch {
              parsed = buf.toString('utf8')
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, raw: buf })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * Demultiplex Docker's non-TTY stream framing.
 * Frame = 8-byte header [type,0,0,0, size:uint32BE] + payload.
 * type: 0=stdin 1=stdout 2=stderr.
 * Returns leftover bytes so a streaming caller can resume on the next chunk —
 * partial frames are the usual source of corruption bugs here.
 * @returns {{stdout:Buffer, stderr:Buffer, rest:Buffer}}
 */
export function demux(buffer) {
  const out = []
  const err = []
  let offset = 0
  while (offset + 8 <= buffer.length) {
    const type = buffer[offset]
    const size = buffer.readUInt32BE(offset + 4)
    if (offset + 8 + size > buffer.length) break // partial payload: wait for more
    const payload = buffer.subarray(offset + 8, offset + 8 + size)
    if (type === 2) err.push(payload)
    else if (type === 1) out.push(payload)
    offset += 8 + size
  }
  return {
    stdout: Buffer.concat(out),
    stderr: Buffer.concat(err),
    rest: buffer.subarray(offset),
  }
}

/** Build a Docker stream frame — used by tests and by any writer side. */
export function frame(type, text) {
  const payload = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = type
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

/**
 * Minimal USTAR archive containing one regular file. Docker's archive endpoint
 * takes a tar stream, which is the only way to move arbitrarily large content
 * into a container -- a shell command line is capped by ARG_MAX.
 */
export function buildTar(name, content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  const header = Buffer.alloc(512)
  header.write(name.slice(0, 100), 0, 'utf8')          // name
  header.write('000644 \0', 100)                       // mode
  header.write('000000 \0', 108)                       // uid
  header.write('000000 \0', 116)                       // gid
  header.write(data.length.toString(8).padStart(11, '0') + ' ', 124)   // size
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + ' ', 136) // mtime
  header.write('        ', 148)                         // checksum placeholder (spaces)
  header.write('0', 156)                                // typeflag: regular file
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512)
  return Buffer.concat([header, data, padding, Buffer.alloc(1024)]) // 2 zero blocks terminate
}

export class DockerClient {
  constructor(socketPath = DEFAULT_SOCKET) {
    this.socketPath = socketPath
  }
  async ping() {
    const res = await api(this.socketPath, 'GET', '/_ping', undefined, { raw: true })
    return res.status === 200
  }
  async version() {
    return (await api(this.socketPath, 'GET', '/version')).body
  }
  /** Create a long-lived container that idles until we exec into it. */
  async createContainer({ image, name, binds = [], env = [], workdir = '/workspace' }) {
    const res = await api(this.socketPath, 'POST', `/containers/create${name ? `?name=${name}` : ''}`, {
      Image: image,
      Cmd: ['sleep', 'infinity'],
      WorkingDir: workdir,
      Env: env,
      Tty: false,
      HostConfig: { Binds: binds, AutoRemove: false },
    })
    if (res.status !== 201) throw new Error(`createContainer failed (${res.status}): ${JSON.stringify(res.body)}`)
    return res.body.Id
  }
  async start(id) {
    const res = await api(this.socketPath, 'POST', `/containers/${id}/start`)
    if (![204, 304].includes(res.status)) throw new Error(`start failed (${res.status})`)
  }
  async inspect(id) {
    return (await api(this.socketPath, 'GET', `/containers/${id}/json`)).body
  }
  async remove(id, force = true) {
    await api(this.socketPath, 'DELETE', `/containers/${id}?force=${force}&v=true`)
  }
  /** Upload a tar stream, extracted at `dirPath` inside the container. */
  async putArchive(id, dirPath, tar) {
    const res = await api(
      this.socketPath,
      'PUT',
      `/containers/${id}/archive?path=${encodeURIComponent(dirPath)}`,
      tar,
      { raw: true, contentType: 'application/x-tar' },
    )
    if (res.status !== 200) throw new Error(`putArchive failed (${res.status}): ${res.raw.toString('utf8').slice(0, 200)}`)
  }

  /** Create an exec instance; returns its id. Used by the streaming spawn path. */
  async exec_create(id, config) {
    const res = await api(this.socketPath, 'POST', `/containers/${id}/exec`, config)
    if (res.status !== 201) throw new Error(`exec create failed (${res.status}): ${JSON.stringify(res.body)}`)
    return res.body.Id
  }

  /** Inspect an exec instance (ExitCode, Pid, Running). */
  async exec_inspect(execId) {
    return (await api(this.socketPath, 'GET', `/exec/${execId}/json`)).body
  }

  /** Upload one file's bytes into `dirPath` inside the container. */
  async putArchiveFile(id, dirPath, name, content) {
    return this.putArchive(id, dirPath, buildTar(name, content))
  }

  /** Run argv inside the container; returns {stdout, stderr, exitCode}. */
  async exec(id, argv, { cwd, env = [] } = {}) {
    const created = await api(this.socketPath, 'POST', `/containers/${id}/exec`, {
      AttachStdout: true,
      AttachStderr: true,
      Cmd: argv,
      Env: env,
      ...(cwd ? { WorkingDir: cwd } : {}),
    })
    if (created.status !== 201) throw new Error(`exec create failed (${created.status})`)
    const execId = created.body.Id
    const started = await api(this.socketPath, 'POST', `/exec/${execId}/start`, { Detach: false, Tty: false }, { raw: true })
    const { stdout, stderr } = demux(started.raw)
    const info = (await api(this.socketPath, 'GET', `/exec/${execId}/json`)).body
    return { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exitCode: info?.ExitCode ?? null }
  }
}
