import assert from 'node:assert'
import { CollectBuffer } from '../src/collect.mjs'
let n = 0
const ok = (m) => { n++; console.log(`  ok  ${m}`) }

// basic accumulate + read
let b = new CollectBuffer({ maxBytes: 100 })
b.push('hello ')
b.push('world')
let r = b.readFrom(0)
assert.equal(r.text, 'hello world'); assert.equal(r.nextOffset, 11); assert.equal(r.lossy, false)
ok('accumulates and reads from 0')

// incremental read resumes at nextOffset
r = b.readFrom(r.nextOffset)
assert.equal(r.text, ''); assert.equal(r.nextOffset, 11)
b.push('!')
r = b.readFrom(11)
assert.equal(r.text, '!'); assert.equal(r.nextOffset, 12)
ok('incremental read returns only the delta')

// NON-CONSUMING: two independent readers never steal from each other
b = new CollectBuffer({ maxBytes: 100 })
b.push('abcdef')
const readerA = b.readFrom(0)
const readerB = b.readFrom(0)
assert.equal(readerA.text, 'abcdef')
assert.equal(readerB.text, 'abcdef', 'second reader must still see everything')
ok('reads are non-consuming across independent readers')

// tail window: overflow keeps the TAIL, older offsets go lossy
b = new CollectBuffer({ maxBytes: 5 })
b.push('0123456789') // 10 bytes into a 5-byte window
r = b.readFrom(0)
assert.equal(r.lossy, true, 'offset 0 slid out of the window')
assert.equal(r.text, '56789', 'returns the retained tail')
assert.equal(r.nextOffset, 10)
ok('overflow keeps tail and reports lossy')

// an offset still inside the window is not lossy
r = b.readFrom(7)
assert.equal(r.lossy, false); assert.equal(r.text, '789')
ok('offset inside window is not lossy')

// truncation surfaced in the settled batch view
assert.deepEqual(b.toCollectedOutput(), { text: '56789', truncated: true })
ok('toCollectedOutput reports truncated')

b = new CollectBuffer({ maxBytes: 100 })
b.push('short')
assert.deepEqual(b.toCollectedOutput(), { text: 'short', truncated: false })
ok('no truncation when under cap')

// spill: complete stream retained under cap
b = new CollectBuffer({ maxBytes: 4, spill: { maxBytes: 1000 } })
b.push('0123456789')
assert.equal(b.completeBytes().toString(), '0123456789', 'spill keeps the whole stream')
assert.equal(b.readFrom(0).text, '6789', 'memory tail still bounded')
ok('spill retains complete stream while tail stays bounded')

// spill discarded once the whole-stream cap is exceeded
b = new CollectBuffer({ maxBytes: 4, spill: { maxBytes: 5 } })
b.push('0123456789')
assert.equal(b.completeBytes(), null, 'over-cap spill is discarded, not truncated')
ok('spill discarded when whole-stream cap exceeded')

// no spill configured
b = new CollectBuffer({ maxBytes: 4 })
b.push('0123456789')
assert.equal(b.completeBytes(), null)
ok('no spill configured -> completeBytes null')

// multi-byte utf8 across the window boundary must not corrupt
b = new CollectBuffer({ maxBytes: 1000 })
b.push(Buffer.from('héllo 🚀', 'utf8').subarray(0, 3))
b.push(Buffer.from('héllo 🚀', 'utf8').subarray(3))
assert.equal(b.readFrom(0).text, 'héllo 🚀')
ok('utf8 split across chunks reassembles correctly')

console.log(`\n${n} checks passed (collect buffer)`)
