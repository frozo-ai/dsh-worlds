// LIVE subprocess spawn test against real Docker.
import assert from 'node:assert'
import { DockerClient } from '../src/docker.mjs'
import { DockerSubprocess, wrapArgv, toDockerEnv } from '../src/subprocess.mjs'

const NAME = 'dsh-worlds-sp-test'
let n = 0
const ok = (m) => { n++; console.log(`  ok  ${m}`) }
const COLLECT = { maxBytes: 1 << 20 }
const stdio = (o = {}) => ({ stdin: 'ignore', stdout: COLLECT, stderr: COLLECT, ...o })

// pure helpers
assert.deepEqual(toDockerEnv({ A: '1', B: undefined }), ['A=1'])
ok('toDockerEnv drops tombstones')
assert.ok(wrapArgv(['echo', 'hi'], '/tmp/p').includes('setsid'))
ok('wrapArgv leads its own process group via setsid')

const docker = new DockerClient()
try { await docker.remove(NAME) } catch {}
const id = await docker.createContainer({ image: 'alpine:latest', name: NAME })
await docker.start(id)
await docker.exec(id, ['mkdir', '-p', '/workspace'])
const sp = new DockerSubprocess(docker, id, '/workspace')
ok('container up')

// resolveExecutable
assert.equal(await sp.resolveExecutable('sh'), '/bin/sh'); ok('resolveExecutable bare name via PATH')
assert.equal(await sp.resolveExecutable('/bin/sh'), '/bin/sh'); ok('resolveExecutable absolute path')
await assert.rejects(() => sp.resolveExecutable('definitely-not-here')); ok('resolveExecutable rejects missing')
await assert.rejects(() => sp.resolveExecutable('rel/path')); ok('rejects relative path with separators')

// basic collect
let h = sp.spawn({ argv: ['echo', 'hello'], cwd: '/workspace', stdio: stdio(), graceMs: 2000 })
let out = await h.done
assert.equal(out.exitCode, 0); assert.equal(out.signal, null)
assert.equal(h.collected.stdout.readFrom(0).text, 'hello\n')
ok('spawn collect: stdout + exit code 0')

// stderr separation + non-zero exit
h = sp.spawn({ argv: ['sh', '-c', 'echo E >&2; exit 7'], cwd: '/workspace', stdio: stdio(), graceMs: 2000 })
out = await h.done
assert.equal(out.exitCode, 7)
assert.equal(h.collected.stderr.readFrom(0).text, 'E\n')
assert.equal(h.collected.stdout.readFrom(0).text, '')
ok('stdout/stderr separated, non-zero exit propagates')

// collected readable AFTER settlement, and still non-consuming
assert.equal(h.collected.stderr.readFrom(0).text, 'E\n')
ok('collected output re-readable after exit')

// cwd + env
h = sp.spawn({ argv: ['sh', '-c', 'pwd; echo $MYVAR'], cwd: '/tmp', stdio: stdio(), graceMs: 2000, env: { MYVAR: 'from-spec' } })
await h.done
assert.equal(h.collected.stdout.readFrom(0).text, '/tmp\nfrom-spec\n')
ok('cwd and explicit env honoured')

// stdin: { data }
h = sp.spawn({ argv: ['cat'], cwd: '/workspace', stdio: stdio({ stdin: { data: 'piped-input\n' } }), graceMs: 2000 })
out = await h.done
assert.equal(h.collected.stdout.readFrom(0).text, 'piped-input\n')
ok('stdin { data } written and closed')

// pipe mode: live streaming
h = sp.spawn({ argv: ['sh', '-c', 'echo a; echo b; echo c'], cwd: '/workspace', stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 2000 })
assert.ok(h.stdout, 'stdout Readable present in pipe mode')
assert.equal(h.collected.stdout, undefined, 'no collect reader in pipe mode')
let streamed = ''
h.stdout.on('data', (c) => { streamed += c })
await h.done
await new Promise((r) => setTimeout(r, 60))
assert.equal(streamed, 'a\nb\nc\n')
ok('pipe mode streams live to a Readable')

// large output through the demux
h = sp.spawn({ argv: ['sh', '-c', 'for i in $(seq 1 3000); do echo line-$i; done'], cwd: '/workspace', stdio: stdio(), graceMs: 5000 })
await h.done
const lines = h.collected.stdout.readFrom(0).text.trim().split('\n')
assert.equal(lines.length, 3000); assert.equal(lines[2999], 'line-3000')
ok(`3000 lines intact across frame boundaries`)

// incremental non-consuming reads while running
h = sp.spawn({ argv: ['sh', '-c', 'echo one; sleep 0.4; echo two'], cwd: '/workspace', stdio: stdio(), graceMs: 3000 })
await new Promise((r) => setTimeout(r, 250))
const first = h.collected.stdout.readFrom(0)
assert.equal(first.text, 'one\n')
await h.done
const second = h.collected.stdout.readFrom(first.nextOffset)
assert.equal(second.text, 'two\n', 'delta only')
assert.equal(h.collected.stdout.readFrom(0).text, 'one\ntwo\n', 'full re-read still works')
ok('incremental reads mid-flight, non-consuming')

// terminate: SIGTERM escalation kills the whole group
h = sp.spawn({ argv: ['sh', '-c', 'sleep 30 & sleep 30'], cwd: '/workspace', stdio: stdio(), graceMs: 500 })
await new Promise((r) => setTimeout(r, 400))
h.terminate()
out = await h.done
assert.ok(out.signal !== null || out.exitCode !== 0, `terminated (exit=${out.exitCode} sig=${out.signal})`)
ok(`terminate() escalation ended the process (exit=${out.exitCode} sig=${out.signal})`)
const leftover = await docker.exec(id, ['sh', '-c', 'ps -o args | grep -c "[s]leep 30" || true'])
assert.equal(leftover.stdout.trim(), '0', 'no orphaned children')
ok('termination was tree-scoped: no orphaned background child')

// abort signal triggers the same path
const ac = new AbortController()
h = sp.spawn({ argv: ['sleep', '30'], cwd: '/workspace', stdio: stdio(), graceMs: 500, signal: ac.signal })
await new Promise((r) => setTimeout(r, 300))
ac.abort()
out = await h.done
assert.notEqual(out.exitCode, 0)
ok('abort signal starts the terminate escalation')

// waitForExit observes the tree
h = sp.spawn({ argv: ['sh', '-c', 'sleep 0.3'], cwd: '/workspace', stdio: stdio(), graceMs: 2000 })
assert.equal(await h.waitForExit(), true)
ok('waitForExit resolves true once the tree is gone')

// terminate is idempotent and safe post-exit
h.terminate(); h.terminate()
ok('terminate() idempotent / no-op after exit')

await docker.remove(id)
ok('cleanup')
console.log(`\n${n} checks passed (subprocess spawn, live Docker)`)
