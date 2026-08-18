// Bounded output collection with offset-based, NON-CONSUMING reads.
// Contract: SubprocessCollect / SubprocessOutputReader in
// packages/subprocess/subprocess/src/types.ts.
//
// Offsets are whole-stream byte coordinates owned by the caller, so two
// independent readers can never consume one another's output. When an offset
// has slid out of the retained tail the read is `lossy` and returns the whole
// tail; the gap is only recoverable from the spill file.

export class CollectBuffer {
  /** @param {{maxBytes:number, spill?:{maxBytes:number}}} opts */
  constructor(opts) {
    this.maxBytes = opts.maxBytes
    this.spillCap = opts.spill?.maxBytes
    this.total = 0 // whole-stream bytes seen
    this.tail = Buffer.alloc(0) // retained window, <= maxBytes
    this.full = this.spillCap === undefined ? null : [] // complete stream, until cap
    this.fullBytes = 0
    this.spillOverflowed = false
    this.spillPath = undefined
  }

  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (buf.length === 0) return
    this.total += buf.length

    // retained tail
    this.tail = this.tail.length === 0 ? buf : Buffer.concat([this.tail, buf])
    if (this.tail.length > this.maxBytes) {
      this.tail = this.tail.subarray(this.tail.length - this.maxBytes)
    }

    // full-stream spill accumulation, discarded once it exceeds its cap
    if (this.full && !this.spillOverflowed) {
      this.fullBytes += buf.length
      if (this.fullBytes > this.spillCap) {
        this.spillOverflowed = true // a larger stream discards its now-incomplete spill
        this.full = null
      } else {
        this.full.push(buf)
      }
    }
  }

  /** First whole-stream offset still present in the retained tail. */
  get windowStart() {
    return this.total - this.tail.length
  }

  /** @returns {{text:string, nextOffset:number, lossy:boolean, spillPath?:string}} */
  readFrom(fromByte) {
    const start = this.windowStart
    const lossy = fromByte < start
    const from = lossy ? 0 : Math.min(fromByte - start, this.tail.length)
    return {
      text: this.tail.subarray(from).toString('utf8'),
      nextOffset: this.total,
      lossy,
      ...(this.spillPath ? { spillPath: this.spillPath } : {}),
    }
  }

  /** Settled batch view — the CollectedOutput shape. */
  toCollectedOutput() {
    return {
      text: this.tail.toString('utf8'),
      truncated: this.total > this.tail.length,
      ...(this.spillPath ? { spillPath: this.spillPath } : {}),
    }
  }

  /** Complete stream bytes when the spill is intact, else null. */
  completeBytes() {
    if (!this.full || this.spillOverflowed) return null
    return Buffer.concat(this.full)
  }
}
