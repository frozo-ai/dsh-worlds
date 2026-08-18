/** Ambient types for the zero-dependency JS engines the adapter delegates to. */
declare module '../src/docker.mjs' {
  export class DockerClient {
    readonly socketPath: string
    constructor(socketPath?: string)
    ping(): Promise<boolean>
    version(): Promise<{ Version: string }>
    createContainer(opts: { image: string; name?: string; binds?: string[]; env?: string[]; workdir?: string }): Promise<string>
    start(id: string): Promise<void>
    inspect(id: string): Promise<{ Id?: string; State?: { Running?: boolean } } | undefined>
    remove(id: string, force?: boolean): Promise<void>
    exec(id: string, argv: string[], opts?: { cwd?: string; env?: string[] }): Promise<{ stdout: string; stderr: string; exitCode: number | null }>
    exec_create(id: string, config: Record<string, unknown>): Promise<string>
    exec_inspect(execId: string): Promise<{ ExitCode: number | null } | undefined>
    putArchive(id: string, dirPath: string, tar: Buffer): Promise<void>
    putArchiveFile(id: string, dirPath: string, name: string, content: Buffer): Promise<void>
  }
  export function demux(buffer: Buffer): { stdout: Buffer; stderr: Buffer; rest: Buffer }
  export function buildTar(name: string, content: Buffer | string): Buffer
}

declare module '../src/fs.mjs' {
  export class DockerFs {
    constructor(docker: unknown, containerId: string, defaultCwd?: string)
    resolve(path: string, opts?: { cwd?: string }): Promise<{ targetKey: string; displayPath: string }>
    processPath(target: { targetKey: string }): string
    fileUrl(target: { targetKey: string }): string
    contains(parent: { targetKey: string }, child: { targetKey: string }): boolean
    stat(target: { targetKey: string; displayPath: string }): Promise<{ version: string; type: string; size?: number } | undefined>
    lstat(path: string, opts?: { cwd?: string }): Promise<{ version: string; type: string; size?: number } | undefined>
    readText(target: { targetKey: string; displayPath: string }): Promise<string>
    streamText(target: { targetKey: string; displayPath: string }): Promise<AsyncIterable<string>>
    readBytes(target: { targetKey: string; displayPath: string }, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
    listDir(target: { targetKey: string; displayPath: string }): Promise<Array<Record<string, unknown>>>
    writeText(target: { targetKey: string; displayPath: string }, content: string, expected?: unknown): Promise<Record<string, unknown>>
    editText(target: { targetKey: string; displayPath: string }, edit: unknown, expected?: unknown): Promise<Record<string, unknown>>
  }
  export class FsError extends Error { code: string }
}

declare module '../src/subprocess.mjs' {
  export class DockerSubprocess {
    constructor(docker: unknown, containerId: string, defaultCwd?: string)
    resolveExecutable(command: string, env?: Readonly<Record<string, string>>): Promise<string>
    spawn(spec: unknown): Record<string, unknown>
  }
}

declare module '../src/terminal.mjs' {
  export class DockerTerminal {
    constructor(docker: unknown, containerId: string)
    spawn(spec: unknown): Promise<Record<string, unknown>>
    resize(execId: string, rows: number, cols: number): Promise<void>
  }
  export function parseTpgid(statLine: string): number | undefined
  export function parseState(statLine: string): string | undefined
}
