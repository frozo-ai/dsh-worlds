// LIVE fs-provider test against real Docker. Requires docker running.
import assert from 'node:assert'
import { DockerClient } from '../src/docker.mjs'
import { DockerFs, normalizeLf, countOccurrences, decodeTextOrThrow } from '../src/fs.mjs'

const NAME = 'dsh-worlds-fs-test'
let n = 0
const ok = (m) => { n++; console.log(`  ok  ${m}`) }
const throws = async (fn, code, msg) => {
  try { await fn(); assert.fail(`expected ${code}`) }
  catch (e) { assert.equal(e.code, code, `${msg}: got ${e.code}`); ok(`${msg} -> ${code}`) }
}

// ---- pure helpers (no Docker) ----
assert.equal(normalizeLf('a\r\nb'), 'a\nb'); ok('normalizeLf CRLF->LF')
assert.equal(countOccurrences('aXbXc', 'X'), 2); ok('countOccurrences')
assert.equal(countOccurrences('aaaa', 'aa'), 2); ok('countOccurrences non-overlapping')
try { decodeTextOrThrow(Buffer.from([0x41, 0x00, 0x42]), 'f'); assert.fail() }
catch (e) { assert.equal(e.code, 'FS_NOT_TEXT'); ok('decodeText rejects NUL bytes') }
try { decodeTextOrThrow(Buffer.from([0xff, 0xfe, 0xfd]), 'f'); assert.fail() }
catch (e) { assert.equal(e.code, 'FS_NOT_TEXT'); ok('decodeText rejects invalid UTF-8') }

// ---- live ----
const docker = new DockerClient()
try { await docker.remove(NAME) } catch {}
const id = await docker.createContainer({ image: 'alpine:latest', name: NAME })
await docker.start(id)
const fs = new DockerFs(docker, id, '/workspace')
await docker.exec(id, ['mkdir', '-p', '/workspace'])
ok('container up')

// resolve / path logic
const t = await fs.resolve('hello.txt')
assert.equal(t.targetKey, '/workspace/hello.txt'); ok('resolve relative -> absolute')
assert.equal(fs.processPath(t), '/workspace/hello.txt'); ok('processPath')
assert.equal(fs.fileUrl(t), 'file:///workspace/hello.txt'); ok('fileUrl')
const dir = await fs.resolve('/workspace')
assert.equal(fs.contains(dir, t), true); ok('contains: parent contains child')
assert.equal(fs.contains(t, dir), false); ok('contains: child does not contain parent')
assert.equal(fs.contains(await fs.resolve('/work'), t), false); ok('contains: prefix is not containment')

// absent target
assert.equal(await fs.stat(t), undefined); ok('stat absent -> undefined')
await throws(() => fs.readText(t), 'FS_NOT_FOUND', 'readText absent')

// create
const w1 = await fs.writeText(t, 'line one\nline two\n')
assert.equal(w1.operation, 'create'); assert.equal(w1.before, null)
assert.equal(w1.after, 'line one\nline two\n'); ok('writeText create')
assert.equal(await fs.readText(t), 'line one\nline two\n'); ok('readText round-trip')

const info = await fs.stat(t)
assert.equal(info.type, 'file'); assert.equal(info.size, 18); ok(`stat -> file, size ${info.size}`)

// guards
await throws(() => fs.writeText(t, 'x', { kind: 'createIfAbsent' }), 'FS_NOT_OBSERVED', 'createIfAbsent on existing')
await throws(() => fs.writeText(t, 'x', { kind: 'replaceIfVersion', version: 'bogus:0:0' }), 'FS_STALE_VERSION', 'stale version guard')

const w2 = await fs.writeText(t, 'replaced\n', { kind: 'replaceIfVersion', version: info.version })
assert.equal(w2.operation, 'update'); assert.equal(w2.before, 'line one\nline two\n'); ok('writeText replace with valid version')
assert.notEqual(w2.version, info.version); ok('version changes after write')

// CRLF normalization
const wCrlf = await fs.writeText(t, 'a\r\nb\r\n')
assert.equal(wCrlf.after, 'a\nb\n'); ok('writeText normalizes CRLF')

// edits
await fs.writeText(t, 'alpha beta alpha\n')
const e1 = await fs.editText(t, { oldString: 'beta', newString: 'GAMMA', replaceAll: false })
assert.equal(e1.after, 'alpha GAMMA alpha\n'); ok('editText single replace')
await throws(() => fs.editText(t, { oldString: 'alpha', newString: 'x', replaceAll: false }), 'FS_AMBIGUOUS_EDIT', 'ambiguous edit')
const e2 = await fs.editText(t, { oldString: 'alpha', newString: 'x', replaceAll: true })
assert.equal(e2.after, 'x GAMMA x\n'); ok('editText replaceAll')
await throws(() => fs.editText(t, { oldString: 'nope', newString: 'y', replaceAll: false }), 'FS_EDIT_NOT_FOUND', 'edit not found')

// unicode + shell-hostile content survives the base64 channel
const tricky = await fs.resolve("weird's \"file\".txt")
const payload = `emoji 🚀 · quotes ' " \` · $(echo pwned) · backslash \\ · tab\there\n`
await fs.writeText(tricky, payload)
assert.equal(await fs.readText(tricky), payload); ok('shell-hostile + unicode content round-trips intact')

// binary rejection
await docker.exec(id, ['sh', '-c', 'printf "\\x00\\x01\\x02binary" > /workspace/bin.dat'])
const binT = await fs.resolve('bin.dat')
await throws(() => fs.readText(binT), 'FS_NOT_TEXT', 'readText binary')
const bytes = await fs.readBytes(binT, undefined, 1000)
assert.equal(bytes[0], 0); assert.equal(bytes.length, 9); ok('readBytes returns raw binary intact')
await throws(() => fs.readBytes(binT, undefined, 3), 'FS_TOO_LARGE', 'readBytes maxBytes cap')

// listDir
await docker.exec(id, ['sh', '-c', 'mkdir -p /workspace/sub && touch /workspace/.hidden /workspace/zeta.txt'])
const entries = await fs.listDir(dir)
const names = entries.map((e) => e.name)
assert.ok(names.includes('.hidden'), 'hidden files listed')
assert.ok(names.includes('sub'))
assert.deepEqual(names, [...names].sort()); ok(`listDir stable order, ${entries.length} entries incl. hidden`)
assert.equal(entries.find((e) => e.name === 'sub').type, 'directory'); ok('listDir types')
assert.ok(entries.find((e) => e.name === 'zeta.txt').target.targetKey === '/workspace/zeta.txt'); ok('listDir child targets')
await throws(() => fs.listDir(t), 'FS_NOT_DIRECTORY', 'listDir on a file')

// lstat does not follow symlinks
await docker.exec(id, ['ln', '-sf', '/workspace/hello.txt', '/workspace/link.txt'])
assert.equal((await fs.lstat('link.txt')).type, 'symlink'); ok('lstat reports symlink')
const linkT = await fs.resolve('link.txt')
assert.equal((await fs.stat(linkT)).type, 'file'); ok('stat follows symlink to file')

// streamText over a large file
const big = 'x'.repeat(200_000) + '\n'
const bigT = await fs.resolve('big.txt')
await fs.writeText(bigT, big)
let acc = ''
for await (const chunk of await fs.streamText(bigT)) acc += chunk
assert.equal(acc.length, big.length); ok(`streamText reassembles ${acc.length} chars`)

await docker.remove(id)
ok('cleanup')
console.log(`\n${n} checks passed (fs provider, live Docker)`)
