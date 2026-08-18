// dsh-worlds filesystem engine: implements the `ctx.fs` seam surface over a
// Docker container. Pure JS engine — the Cordis/TS binding is a thin adapter.
// Contract: packages/fs/fs/src/index.ts + types.ts in the dsh repo.
import { posix } from 'node:path'
import { buildTar } from './docker.mjs'

export class FsError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'FsError'
    this.code = code
  }
}

/** Single-quote a string for safe POSIX shell interpolation. */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** stat format: inode:mtime:size — the freshness token components. */
const STAT_FMT = '%i:%Y:%s'

const TYPE_MAP = {
  'regular file': 'file',
  'regular empty file': 'file',
  directory: 'directory',
  'symbolic link': 'symlink',
}
const normType = (raw) => TYPE_MAP[raw?.trim()] ?? 'other'

export class DockerFs {
  /**
   * @param docker - DockerClient instance
   * @param containerId - target container
   * @param defaultCwd - base for relative resolution
   */
  constructor(docker, containerId, defaultCwd = '/workspace') {
    this.docker = docker
    this.id = containerId
    this.defaultCwd = defaultCwd
  }

  async #sh(script) {
    return this.docker.exec(this.id, ['sh', '-c', script])
  }

  // ---------- pure path logic (no daemon call) ----------

  /** Resolve a path to a stable identity inside the container. */
  async resolve(path, opts = {}) {
    const cwd = opts.cwd ?? this.defaultCwd
    const abs = posix.isAbsolute(path) ? posix.normalize(path) : posix.normalize(posix.join(cwd, path))
    // realpath when it exists; otherwise keep the normalized path so a
    // guarded create can still address an absent target.
    const r = await this.#sh(`realpath ${q(abs)} 2>/dev/null || printf %s ${q(abs)}`)
    const key = r.stdout.trim() || abs
    return { targetKey: key, displayPath: key }
  }

  processPath(target) {
    return target.targetKey
  }

  fileUrl(target) {
    return `file://${target.targetKey}`
  }

  contains(parent, child) {
    const p = posix.normalize(parent.targetKey).replace(/\/+$/, '')
    const c = posix.normalize(child.targetKey)
    return c === p || c.startsWith(p + '/')
  }

  // ---------- metadata ----------

  async stat(target) {
    const r = await this.#sh(`stat -c ${q(STAT_FMT + '|%F')} ${q(target.targetKey)} 2>/dev/null`)
    if (r.exitCode !== 0 || !r.stdout.trim()) return undefined
    const [version, rawType] = r.stdout.trim().split('|')
    const type = normType(rawType)
    const size = Number(version.split(':')[2])
    return { version, type: type === 'symlink' ? 'file' : type, ...(Number.isFinite(size) ? { size } : {}) }
  }

  /** Path-level probe that does NOT follow a final symlink. */
  async lstat(path, opts = {}) {
    const cwd = opts.cwd ?? this.defaultCwd
    const abs = posix.isAbsolute(path) ? posix.normalize(path) : posix.normalize(posix.join(cwd, path))
    const r = await this.#sh(`stat -c ${q(STAT_FMT + '|%F')} ${q(abs)} 2>/dev/null`) // busybox stat = lstat by default
    if (r.exitCode !== 0 || !r.stdout.trim()) return undefined
    const [version, rawType] = r.stdout.trim().split('|')
    const size = Number(version.split(':')[2])
    return { version, type: normType(rawType), ...(Number.isFinite(size) ? { size } : {}) }
  }

  // ---------- reads ----------

  /** Raw bytes, bounded. Base64 over the exec channel keeps binary intact. */
  async readBytes(target, _signal, maxBytes) {
    const info = await this.stat(target)
    if (!info) throw new FsError(`not found: ${target.displayPath}`, 'FS_NOT_FOUND')
    if (info.type === 'directory') throw new FsError(`not a regular file: ${target.displayPath}`, 'FS_NOT_REGULAR_FILE')
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(`file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
    }
    const r = await this.#sh(`base64 ${q(target.targetKey)}`)
    if (r.exitCode !== 0) throw new FsError(r.stderr || 'read failed', 'FS_IO_ERROR')
    const buf = Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64')
    if (buf.length > maxBytes) throw new FsError(`file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
    return new Uint8Array(buf)
  }

  /** Decoded text with binary rejection. */
  async readText(target, signal) {
    const bytes = await this.readBytes(target, signal, Number.MAX_SAFE_INTEGER)
    return decodeTextOrThrow(Buffer.from(bytes), target.displayPath)
  }

  /** Chunked text for large files; decoding is validated up front. */
  async streamText(target, signal) {
    const text = await this.readText(target, signal)
    const CHUNK = 64 * 1024
    return (async function* () {
      for (let i = 0; i < text.length; i += CHUNK) yield text.slice(i, i + CHUNK)
    })()
  }

  async listDir(target) {
    const info = await this.stat(target)
    if (!info) throw new FsError(`not found: ${target.displayPath}`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`not a directory: ${target.displayPath}`, 'FS_NOT_DIRECTORY')
    // One exec: stat every direct child. Name goes last so earlier fields parse cleanly.
    const script = `cd ${q(target.targetKey)} && ls -A | while IFS= read -r f; do stat -c ${q(STAT_FMT + '|%F|')}"$f" "$f" 2>/dev/null; done`
    const r = await this.#sh(script)
    const entries = []
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue
      const first = line.indexOf('|')
      const second = line.indexOf('|', first + 1)
      if (first < 0 || second < 0) continue
      const version = line.slice(0, first)
      const type = normType(line.slice(first + 1, second))
      const name = line.slice(second + 1)
      const size = Number(version.split(':')[2])
      entries.push({
        name,
        type: type === 'symlink' ? 'file' : type,
        target: { targetKey: posix.join(target.targetKey, name), displayPath: posix.join(target.targetKey, name) },
        version,
        ...(Number.isFinite(size) ? { size } : {}),
      })
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  // ---------- writes ----------

  /** Atomic create-or-replace with optional intent guard. */
  async writeText(target, content, expected) {
    const info = await this.stat(target)
    if (expected?.kind === 'createIfAbsent' && info) {
      throw new FsError(`already exists: ${target.displayPath}`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (!info) throw new FsError(`absent, cannot replace: ${target.displayPath}`, 'FS_STALE_VERSION')
      if (info.version !== expected.version) {
        throw new FsError(`version changed: ${target.displayPath}`, 'FS_STALE_VERSION')
      }
    }
    const before = info ? normalizeLf(await this.readText(target)) : null
    const after = normalizeLf(content)
    await this.#atomicWrite(target.targetKey, after)
    const next = await this.stat(target)
    return { operation: info ? 'update' : 'create', version: next.version, before, after }
  }

  /** Atomic literal search/replace. */
  async editText(target, edit, expected) {
    const info = await this.stat(target)
    if (!info) throw new FsError(`not found: ${target.displayPath}`, 'FS_NOT_FOUND')
    if (expected?.version && info.version !== expected.version) {
      throw new FsError(`version changed: ${target.displayPath}`, 'FS_STALE_VERSION')
    }
    if (!edit.oldString) throw new FsError('oldString must be non-empty', 'FS_EDIT_NOT_FOUND')
    const before = normalizeLf(await this.readText(target))
    const oldStr = normalizeLf(edit.oldString)
    const occurrences = countOccurrences(before, oldStr)
    if (occurrences === 0) throw new FsError('oldString not found', 'FS_EDIT_NOT_FOUND')
    if (occurrences > 1 && !edit.replaceAll) {
      throw new FsError(`oldString matched ${occurrences} times; pass replaceAll`, 'FS_AMBIGUOUS_EDIT')
    }
    const newStr = normalizeLf(edit.newString)
    const after = edit.replaceAll ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr)
    await this.#atomicWrite(target.targetKey, after)
    const next = await this.stat(target)
    return { version: next.version, before, after }
  }

  /**
   * Upload to a temp name via the archive API, then `mv` into place — atomic
   * publication on the same filesystem, with no ARG_MAX ceiling on content size.
   */
  async #atomicWrite(path, content) {
    const dir = posix.dirname(path)
    const tmpName = `.${posix.basename(path)}.dsh-worlds.tmp`
    const tmpPath = posix.join(dir, tmpName)
    const mk = await this.#sh(`mkdir -p ${q(dir)}`)
    if (mk.exitCode !== 0) throw new FsError(mk.stderr || 'mkdir failed', 'FS_IO_ERROR')
    try {
      await this.docker.putArchive(this.id, dir, buildTar(tmpName, content))
    } catch (cause) {
      throw new FsError(`write failed: ${cause.message}`, 'FS_IO_ERROR', { cause })
    }
    const mv = await this.#sh(`mv -f ${q(tmpPath)} ${q(path)}`)
    if (mv.exitCode !== 0) {
      await this.#sh(`rm -f ${q(tmpPath)}`)
      throw new FsError(mv.stderr || 'publish failed', 'FS_IO_ERROR')
    }
  }
}

// ---------- pure helpers (unit-testable without Docker) ----------

export function normalizeLf(text) {
  return text.replace(/\r\n/g, '\n')
}

export function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    count++
    i = haystack.indexOf(needle, i + needle.length)
  }
  return count
}

export function decodeTextOrThrow(buf, displayPath) {
  if (buf.includes(0)) throw new FsError(`not text: ${displayPath}`, 'FS_NOT_TEXT')
  const text = buf.toString('utf8')
  // Buffer.toString inserts U+FFFD for invalid sequences; round-trip detects it.
  if (Buffer.compare(Buffer.from(text, 'utf8'), buf) !== 0) {
    throw new FsError(`not valid UTF-8: ${displayPath}`, 'FS_NOT_TEXT')
  }
  return text
}
