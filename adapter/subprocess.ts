/**
 * Docker provider for the subprocess capability seam (`ctx.subprocess`).
 * Mounting this beside the fs provider places Bash, the file tools, and the
 * LSP host in one shared container world — none of them need forking, because
 * they delegate every execution-world operation to these two seams.
 * @module dsh-worlds/adapter/subprocess
 */
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle, SubprocessSpawnSpec,
  SubprocessTerminalHandle, SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { Context } from '@deepseek-ai/cordis'
// @ts-expect-error -- JS engine, typed via engines.d.ts
import { DockerSubprocess } from '../src/subprocess.mjs'
// @ts-expect-error -- JS engine, typed via engines.d.ts
import { DockerTerminal } from '../src/terminal.mjs'

export class DockerSubprocessRuntime extends SubprocessRuntime {
  /** Non-private on purpose: cordis proxies services, and #private fields
   * are unreadable through a Proxy. */
  _engine: InstanceType<typeof DockerSubprocess> | undefined
  _terminal: InstanceType<typeof DockerTerminal> | undefined

  constructor(ctx: Context) {
    super(ctx)
    this.ctx.inject(['world'], (scoped) => {
      this._engine = new DockerSubprocess(scoped.world.docker, scoped.world.containerId, scoped.world.workdir)
      this._terminal = new DockerTerminal(scoped.world.docker, scoped.world.containerId)
    })
  }

  get engine(): InstanceType<typeof DockerSubprocess> {
    if (this._engine === undefined) throw new Error('world not started')
    return this._engine
  }

  async resolveExecutable(
    command: string, env?: Readonly<Record<string, string>>, _signal?: AbortSignal,
  ): Promise<string> {
    return this.engine.resolveExecutable(command, env)
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    return this.engine.spawn(spec) as unknown as SubprocessHandle
  }

  /**
   * Allocate a real PTY inside the container over Docker's hijacked exec
   * connection. With `Tty: true` the output stream carries raw bytes rather
   * than the 8-byte stream framing, and foreground-group facts come from
   * `/proc/<pid>/stat` field 8 (tpgid) inside the container.
   */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this._terminal === undefined) throw new Error('world not started')
    return (await this._terminal.spawn(spec)) as unknown as SubprocessTerminalHandle
  }
}

export default DockerSubprocessRuntime
