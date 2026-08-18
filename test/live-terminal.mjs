// LIVE PTY test against real Docker.
// Callers: `npm run verify:terminal`. Exercises src/terminal.mjs.
import assert from 'node:assert'
import { DockerClient } from '../src/docker.mjs'
import { DockerTerminal, parseTpgid, parseState } from '../src/terminal.mjs'

const NAME = 'dsh-worlds-tty-test'
let n = 0
const ok = (m) => { n++; console.log(`  ok  ${m}`) }
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 60)) }
  return false
}

// --- pure /proc parsing (comm may contain spaces and parens) ---
assert.equal(parseTpgid('123 (bash) S 1 123 123 34816 456 x'), 456)
ok('parseTpgid reads field 8')
assert.equal(parseTpgid('7 (weird (proc) name) S 1 7 7 34816 99 x'), 99)
ok('parseTpgid survives parens/spaces in comm')
assert.equal(parseState('123 (bash) S 1 123'), 'S')
ok('parseState reads field 3')
assert.equal(parseTpgid('no-paren-line'), undefined)
ok('parseTpgid rejects malformed input')

const docker = new DockerClient()
try { await docker.remove(NAME) } catch { /* absent */ }
const id = await docker.createContainer({ image: 'alpine:latest', name: NAME })
await docker.start(id)
await docker.exec(id, ['sh', '-c', 'apk add --no-cache bash procps >/dev/null 2>&1'])
await docker.exec(id, ['mkdir', '-p', '/workspace'])
const term = new DockerTerminal(docker, id)
ok('container up with bash + procps')

// --- allocate a PTY running an interactive shell ---
let out = ''
const h = await term.spawn({
  argv: ['bash', '-i'], cwd: '/workspace',
  env: { PS1: 'READY> ', TERM: 'xterm' }, rows: 24, cols: 80, graceMs: 3000,
})
h.output.on('data', (c) => { out += c })
assert.ok(h.pid > 0, `pid resolved (${h.pid})`)
ok(`PTY allocated, pid ${h.pid}`)

// --- it is a REAL tty (the whole point of this primitive) ---
await h.write('tty; test -t 0 && echo IS_A_TTY\n')
assert.ok(await waitFor(() => out.includes('IS_A_TTY')), 'expected tty check to pass')
assert.ok(/\/dev\/(pts|ptmx|console)/.test(out), `tty device expected in: ${out.slice(-140)}`)
ok('stdin is a real tty (test -t 0 passed, /dev/pts device present)')

// --- interactive round trip ---
out = ''
await h.write('echo interactive-$((6*7))\n')
assert.ok(await waitFor(() => out.includes('interactive-42')), `got: ${out.slice(-140)}`)
ok('interactive write -> output round trip')

// --- raw stream: no docker 8-byte frame headers when Tty:true ---
const NUL = String.fromCharCode(0)
assert.ok(!out.includes(NUL + NUL + NUL), 'tty stream must not carry stream framing')
ok('tty output is raw (no 8-byte stream framing)')

// --- resize propagates into the pty ---
out = ''
await h.resize(40, 132)
await new Promise((r) => setTimeout(r, 300))
await h.write('stty size\n')
assert.ok(await waitFor(() => /40\s+132/.test(out)), `expected "40 132", got: ${out.slice(-140)}`)
ok('resize propagates to the pty (stty size = 40 132)')

// --- foreground group inspection ---
out = ''
await h.write('sleep 30\n')
await new Promise((r) => setTimeout(r, 900))
const fg = await h.inspectForeground()
assert.ok(fg && fg.processGroupId > 0, `foreground group resolved: ${JSON.stringify(fg)}`)
ok(`inspectForeground -> pgid ${fg.processGroupId}, inputWaiting=${fg.inputWaiting}`)

// --- signal only the foreground group; the session shell must survive ---
const signalled = await h.signalForeground('SIGINT')
assert.equal(signalled, fg.processGroupId)
ok(`signalForeground(SIGINT) -> group ${signalled}`)
out = ''
await h.write('echo still-alive-marker\n')
assert.ok(await waitFor(() => out.includes('still-alive-marker')), 'shell should survive SIGINT to the foreground group')
ok('shell survived: the signal hit the foreground group, not the session')

// --- terminate the whole session ---
await h.terminate()
const outcome = await h.done
ok(`terminate() settled: exit=${outcome.exitCode} sig=${outcome.signal}`)
const left = await docker.exec(id, ['sh', '-c', 'ps -o args | grep -c "[b]ash -i" || true'])
assert.equal(left.stdout.trim(), '0', 'no surviving shell')
ok('session fully reaped: no surviving "bash -i"')

await h.terminate()
ok('terminate() idempotent')

await docker.remove(id)
ok('cleanup')
console.log(`\n${n} checks passed (PTY, live Docker)`)
