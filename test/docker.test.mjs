// Tests the Docker client against a FAKE Engine API daemon on a unix socket.
// No Docker required — the fake speaks the real wire protocol, so the same
// client code runs unchanged against a real daemon.
import assert from 'node:assert'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DockerClient, demux, frame } from '../src/docker.mjs'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`) }

// ---------- pure demux logic (the real bug source) ----------
check('demux: single stdout frame', () => {
  const { stdout, stderr, rest } = demux(frame(1, 'hello'))
  assert.equal(stdout.toString(), 'hello')
  assert.equal(stderr.length, 0)
  assert.equal(rest.length, 0)
})

check('demux: interleaved stdout/stderr preserves order per stream', () => {
  const buf = Buffer.concat([frame(1, 'a'), frame(2, 'ERR'), frame(1, 'b')])
  const { stdout, stderr } = demux(buf)
  assert.equal(stdout.toString(), 'ab')
  assert.equal(stderr.toString(), 'ERR')
})

check('demux: partial header is returned as rest, not consumed', () => {
  const full = frame(1, 'hello')
  const { stdout, rest } = demux(full.subarray(0, 5))
  assert.equal(stdout.length, 0)
  assert.equal(rest.length, 5)
})

check('demux: partial payload waits for more bytes', () => {
  const full = frame(1, 'hello world')
  const { stdout, rest } = demux(full.subarray(0, 12)) // 8 hdr + 4 of 11 bytes
  assert.equal(stdout.length, 0, 'must not emit a truncated payload')
  assert.equal(rest.length, 12)
})

check('demux: streaming resume across chunk boundary', () => {
  const full = Buffer.concat([frame(1, 'part-one '), frame(1, 'part-two')])
  const split = 13 // mid second frame
  const first = demux(full.subarray(0, split))
  const second = demux(Buffer.concat([first.rest, full.subarray(split)]))
  assert.equal(first.stdout.toString() + second.stdout.toString(), 'part-one part-two')
})

check('demux: stdin frames (type 0) are ignored', () => {
  const { stdout, stderr } = demux(Buffer.concat([frame(0, 'in'), frame(1, 'out')]))
  assert.equal(stdout.toString(), 'out')
  assert.equal(stderr.length, 0)
})

// ---------- client against a fake daemon ----------
const dir = mkdtempSync(join(tmpdir(), 'dsh-worlds-'))
const sock = join(dir, 'docker.sock')

const fake = createServer((req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (req.url === '/_ping') { res.writeHead(200); return res.end('OK') }
  if (req.url === '/version') return json(200, { Version: '99.0-fake' })
  if (req.url.startsWith('/containers/create')) return json(201, { Id: 'ctr123' })
  if (req.url === '/containers/ctr123/start') { res.writeHead(204); return res.end() }
  if (req.url === '/containers/ctr123/exec') return json(201, { Id: 'exec456' })
  if (req.url === '/exec/exec456/start') {
    res.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' })
    return res.end(Buffer.concat([frame(1, 'ok from container\n'), frame(2, 'warn\n')]))
  }
  if (req.url === '/exec/exec456/json') return json(200, { ExitCode: 0 })
  res.writeHead(404); res.end()
})
await new Promise((r) => fake.listen(sock, r))

const docker = new DockerClient(sock)
assert.equal(await docker.ping(), true); passed++; console.log('  ok  client: ping')
assert.equal((await docker.version()).Version, '99.0-fake'); passed++; console.log('  ok  client: version')

const id = await docker.createContainer({ image: 'alpine' })
assert.equal(id, 'ctr123'); passed++; console.log('  ok  client: createContainer')
await docker.start(id); passed++; console.log('  ok  client: start')

const result = await docker.exec(id, ['echo', 'hi'])
assert.equal(result.stdout, 'ok from container\n')
assert.equal(result.stderr, 'warn\n')
assert.equal(result.exitCode, 0)
passed++; console.log('  ok  client: exec demuxes stdout/stderr + exit code')

fake.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
