/**
 * Container world lifecycle: creates one long-lived Docker container per
 * harness run and exposes it to the fs/subprocess providers.
 *
 * The container is deliberately NOT auto-removed. Its survival past the
 * harness process is the entire point: `packages/terminal/terminal/README.md`
 * records that dsh terminal "sessions are process-local and are not restored
 * after a harness restart" — a container-backed world is not.
 * @module dsh-worlds/adapter/world
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
// @ts-expect-error -- zero-dependency JS engine, typed via adapter/engines.d.ts
import { DockerClient } from '../src/docker.mjs'

export interface WorldConfig {
  /** Image the world runs. Must contain a POSIX shell, `ps`, and `base64`. */
  image?: string
  /** Stable container name — reuse across restarts is what preserves state. */
  containerName?: string
  /** Working directory inside the container. */
  workdir?: string
  /** Host paths to bind, in Docker `src:dst` form. */
  binds?: string[]
  /** Docker Engine API socket. */
  socketPath?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    world: DockerWorld
  }
}

export class DockerWorld extends Service {
  readonly docker: DockerClient
  readonly image: string
  readonly containerName: string
  readonly workdir: string
  readonly binds: string[]
  /** Non-private on purpose: cordis proxies services, and #private fields
   * are unreadable through a Proxy. */
  _containerId: string | undefined

  constructor(ctx: Context, config: WorldConfig = {}) {
    super(ctx, 'world')
    this.docker = new DockerClient(config.socketPath)
    this.image = config.image ?? 'alpine:latest'
    this.containerName = config.containerName ?? 'dsh-world'
    this.workdir = config.workdir ?? '/workspace'
    this.binds = config.binds ?? []
  }

  /** Container id, once the world has started. */
  get containerId(): string {
    if (this._containerId === undefined) throw new Error('world not started')
    return this._containerId
  }

  /**
   * Cordis runs this after construction (`Service.init`); there is no
   * `start()`/`stop()` pair on the base class.
   *
   * Reuse the named container when it already exists — that reuse is what
   * carries cwd, env, and running processes across a harness restart.
   */
  async [Service.init](): Promise<void> {
    if (!(await this.docker.ping())) {
      throw new Error(`Docker is not reachable at ${this.docker.socketPath}`)
    }
    const existing = await this.docker.inspect(this.containerName)
    if (existing?.Id) {
      this._containerId = existing.Id
      if (!existing.State?.Running) await this.docker.start(existing.Id)
    } else {
      this._containerId = await this.docker.createContainer({
        image: this.image,
        name: this.containerName,
        workdir: this.workdir,
        binds: this.binds,
      })
      await this.docker.start(this._containerId)
    }
    await this.docker.exec(this._containerId, ['mkdir', '-p', this.workdir])
  }

  // No disposer is registered on purpose. Cordis would unwind a `ctx.effect()`
  // disposer on unload, and removing the container there would discard exactly
  // the state this provider exists to preserve. Container lifecycle is the
  // operator's call (`docker rm -f <name>`).
}

export default DockerWorld
