/**
 * Docker provider for the filesystem capability seam (`ctx.fs`).
 * Thin adapter: branding, error mapping, and abort checks live here; the
 * container mechanics live in the tested `src/fs.mjs` engine.
 * @module dsh-worlds/adapter/fs
 */
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo,
  FsTarget, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { Context } from '@deepseek-ai/cordis'
// @ts-expect-error -- JS engine, typed via engines.d.ts
import { DockerFs } from '../src/fs.mjs'

const abortCheck = (signal: AbortSignal | undefined, op: string): void => {
  if (signal?.aborted === true) throw new FsError(`${op} aborted`, 'FS_ABORTED')
}

/** Re-throw engine errors as the seam's typed FsError, preserving the code. */
function mapError(error: unknown): never {
  const code = (error as { code?: string })?.code
  const known = new Set([
    'FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE',
    'FS_TOO_LARGE', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED', 'FS_IO_ERROR',
    'FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_AMBIGUOUS_EDIT', 'FS_EDIT_NOT_FOUND', 'FS_ABORTED',
  ])
  if (code !== undefined && known.has(code)) {
    throw new FsError((error as Error).message, code as FsInfo extends never ? never : never, { cause: error })
  }
  throw new FsError(`filesystem operation failed: ${String((error as Error)?.message ?? error)}`, 'FS_IO_ERROR', { cause: error })
}

const brandTarget = (t: { targetKey: string; displayPath: string }): FsTarget => ({
  targetKey: FsTargetKey(t.targetKey),
  displayPath: t.displayPath,
})

export class DockerFileSystem extends FileSystem {
  /** Non-private on purpose: cordis proxies services, and #private fields
   * are unreadable through a Proxy. */
  _engine: InstanceType<typeof DockerFs> | undefined

  constructor(ctx: Context) {
    super(ctx)
    this.ctx.inject(['world'], (scoped) => {
      this._engine = new DockerFs(scoped.world.docker, scoped.world.containerId, scoped.world.workdir)
    })
  }

  get engine(): InstanceType<typeof DockerFs> {
    if (this._engine === undefined) throw new FsError('world not started', 'FS_IO_ERROR')
    return this._engine
  }

  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    abortCheck(opts?.signal, 'resolve')
    try {
      return brandTarget(await this.engine.resolve(path, { cwd: opts?.cwd }))
    } catch (e) { mapError(e) }
  }

  processPath(target: FsTarget): string { return this.engine.processPath(target) }
  fileUrl(target: FsTarget): string { return this.engine.fileUrl(target) }
  contains(parent: FsTarget, child: FsTarget): boolean { return this.engine.contains(parent, child) }

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    abortCheck(signal, 'stat')
    try {
      const info = await this.engine.stat(target)
      return info === undefined ? undefined : { ...info, version: FsVersion(info.version) } as FsInfo
    } catch (e) { mapError(e) }
  }

  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    abortCheck(signal, 'lstat')
    try {
      const info = await this.engine.lstat(path, opts)
      return info === undefined ? undefined : { ...info, version: FsVersion(info.version) } as FsPathInfo
    } catch (e) { mapError(e) }
  }

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    abortCheck(signal, 'readText')
    try { return await this.engine.readText(target) } catch (e) { mapError(e) }
  }

  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    abortCheck(signal, 'streamText')
    try { return await this.engine.streamText(target) } catch (e) { mapError(e) }
  }

  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    abortCheck(signal, 'readBytes')
    try { return await this.engine.readBytes(target, signal, maxBytes) } catch (e) { mapError(e) }
  }

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    abortCheck(signal, 'listDir')
    try {
      const entries = await this.engine.listDir(target)
      return entries.map((e: Record<string, unknown>) => ({
        ...e,
        target: brandTarget(e['target'] as { targetKey: string; displayPath: string }),
        ...(e['version'] !== undefined ? { version: FsVersion(e['version'] as string) } : {}),
      })) as FsDirEntry[]
    } catch (e) { mapError(e) }
  }

  async writeText(
    target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    abortCheck(signal, 'writeText')
    try {
      const out = await this.engine.writeText(target, content, expected)
      return { ...out, version: FsVersion(out['version'] as string) } as FsWriteOutcome
    } catch (e) { mapError(e) }
  }

  async editText(
    target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    abortCheck(signal, 'editText')
    try {
      const out = await this.engine.editText(target, edit, expected)
      return { ...out, version: FsVersion(out['version'] as string) } as FsEditOutcome
    } catch (e) { mapError(e) }
  }
}

export default DockerFileSystem
