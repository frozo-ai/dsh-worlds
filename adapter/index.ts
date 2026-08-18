/**
 * dsh-worlds — run the agent's execution world inside a Docker container.
 *
 * Mounting these three plugins relocates Bash, the file tools, and every other
 * execution-world consumer into a container. Per the harness's own docs, those
 * consumers "need no ... forks. They delegate every execution-world operation
 * to `ctx.fs` and `ctx.subprocess`" — so replacing the two seams moves all of
 * them at once.
 *
 * Load with an overlay patch:
 *
 * ```yaml
 * - insert:
 *     - id: world
 *       name: '/abs/path/to/dsh-worlds/adapter/world.ts'
 *       config: { image: 'alpine:latest', containerName: 'dsh-world' }
 *     - id: fs-docker
 *       name: '/abs/path/to/dsh-worlds/adapter/fs.ts'
 *     - id: subprocess-docker
 *       name: '/abs/path/to/dsh-worlds/adapter/subprocess.ts'
 * ```
 * @module dsh-worlds/adapter
 */
export { DockerWorld, default as World } from './world.ts'
export type { WorldConfig } from './world.ts'
export { DockerFileSystem } from './fs.ts'
export { DockerSubprocessRuntime } from './subprocess.ts'
