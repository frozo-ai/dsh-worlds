// LIVE test against a real Docker daemon. Requires docker running.
//   npm run verify
// Proves the client works end-to-end AND that a container outlives its client
// -- the durability claim the whole project rests on.
import assert from 'node:assert'
import { DockerClient } from '../src/docker.mjs'

const NAME = 'dsh-worlds-live-test'
let passed = 0
const ok = (m) => { passed++; console.log(`  ok  ${m}`) }

const docker = new DockerClient()

assert.equal(await docker.ping(), true)
ok('real daemon ping')

const version = await docker.version()
assert.ok(version.Version)
ok(`real daemon version = ${version.Version}`)

// clean any leftover from a previous run
try { await docker.remove(NAME) } catch {}

const id = await docker.createContainer({ image: 'alpine:latest', name: NAME })
assert.match(id, /^[0-9a-f]{12,}$/)
ok('createContainer against real Docker')

await docker.start(id)
const info = await docker.inspect(id)
assert.equal(info.State.Running, true)
ok('container running')

// --- stdout/stderr demux against REAL Docker framing ---
const r1 = await docker.exec(id, ['sh', '-c', 'echo to-stdout; echo to-stderr >&2'])
assert.equal(r1.stdout, 'to-stdout\n')
assert.equal(r1.stderr, 'to-stderr\n')
assert.equal(r1.exitCode, 0)
ok('exec demuxes real stdout/stderr separately')

// --- non-zero exit propagates ---
const r2 = await docker.exec(id, ['sh', '-c', 'exit 42'])
assert.equal(r2.exitCode, 42)
ok('non-zero exit code propagates')

// --- large output crosses many frame boundaries (the demux stress case) ---
const r3 = await docker.exec(id, ['sh', '-c', 'for i in $(seq 1 5000); do echo "line-$i"; done'])
const lines = r3.stdout.trim().split('\n')
assert.equal(lines.length, 5000)
assert.equal(lines[0], 'line-1')
assert.equal(lines[4999], 'line-5000')
ok(`large output intact across frame boundaries (${r3.stdout.length} bytes, 5000 lines)`)

// --- working directory honoured ---
await docker.exec(id, ['mkdir', '-p', '/workspace/sub'])
const r4 = await docker.exec(id, ['pwd'], { cwd: '/workspace/sub' })
assert.equal(r4.stdout.trim(), '/workspace/sub')
ok('exec honours WorkingDir')

// ================= THE DURABILITY DEMO =================
// Write state + start a background process, then throw the client away
// (simulating the harness dying) and reconnect with a brand-new client.
await docker.exec(id, ['sh', '-c', 'echo "agent-state-v1" > /workspace/state.txt'])
await docker.exec(id, ['sh', '-c', 'nohup sleep 3600 > /dev/null 2>&1 & echo started'])
ok('wrote file + started background process')

// Simulate harness restart: discard client entirely, build a fresh one.
const reconnected = new DockerClient()
const state = await reconnected.exec(id, ['cat', '/workspace/state.txt'])
assert.equal(state.stdout.trim(), 'agent-state-v1')
ok('AFTER RESTART: file state survived')

const procs = await reconnected.exec(id, ['sh', '-c', 'ps -o args | grep -c "[s]leep 3600"'])
assert.equal(procs.stdout.trim(), '1')
ok('AFTER RESTART: background process still running  <-- the thesis')

await docker.remove(id)
ok('cleanup')

console.log(`\n${passed} live checks passed against Docker ${version.Version}`)
