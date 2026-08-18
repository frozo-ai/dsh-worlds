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

export class DockerSubprocessRuntime extends SubprocessRuntime {
  /** Non-private on purpose: cordis proxies services, and #private fields
   * are unreadable through a Proxy. */
  _engine: InstanceType<typeof DockerSubprocess> | undefined

  constructor(ctx: Context) {
    super(ctx)
    this.ctx.inject(['world'], (scoped) => {
      this._engine = new DockerSubprocess(scoped.world.docker, scoped.world.containerId, scoped.world.workdir)
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
   * Not implemented. A PTY needs Docker's hijacked exec connection for
   * bidirectional byte transport, foreground-group inspection, and resize —
   * see SCOPE.md step 5. Failing loudly beats allocating a terminal that
   * silently cannot be typed into.
   */
  async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error(
      'dsh-worlds: spawnTerminal is not implemented yet — PTY support needs the ' +
      "hijacked exec connection. Keep dsh-terminal on the local provider for now.",
    )
  }
}

export default DockerSubprocessRuntime
