import { deflate } from 'pako-esm2'
import { describe, expect, test } from 'vitest'

import {
  inflateRaw,
  inflateRawBatch,
  inflateRawUnknownSize,
} from '../src/index.ts'

/** `pako-esm2` ships without types. */
function zlib(data: Uint8Array) {
  return deflate(data, {}) as Uint8Array
}

function bytes(n: number, seed = 1) {
  // Compressible but not trivially so: a repeating pattern with a wandering
  // byte, which exercises real match-finding rather than one long run.
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = (i % 251) ^ ((i >> 8) + seed)
  }
  return out
}

describe('inflateRaw', () => {
  test('round-trips at a known size', async () => {
    const plain = bytes(10_000)
    expect(await inflateRaw(zlib(plain).subarray(2), plain.length)).toEqual(
      plain,
    )
  })

  test('round-trips an empty input', async () => {
    const plain = new Uint8Array(0)
    expect(await inflateRaw(zlib(plain).subarray(2), 0)).toEqual(plain)
  })

  test('rejects garbage rather than trapping the instance', async () => {
    const plain = bytes(1000)
    await expect(
      inflateRaw(new Uint8Array(64).fill(0xff), plain.length),
    ).rejects.toThrow(/decompression failed/)

    // The crate builds with panic = "abort", so a Rust panic would leave the
    // module unusable for every later call. A rejected promise must not.
    expect(await inflateRaw(zlib(plain).subarray(2), plain.length)).toEqual(
      plain,
    )
  })

  test('does NOT detect a single flipped byte', async () => {
    // Raw deflate carries no checksum — zlib's adler32 lives in the 4-byte
    // trailer this path skips past — so a corruption that still forms a legal
    // bit stream decodes to the wrong bytes silently. Pinned because it is a
    // real property of the API, and a caller needing integrity has to get it
    // from its own container (bgzf's CRC, a bigwig/hic block's known size).
    const plain = bytes(1000)
    const corrupt = zlib(plain).subarray(2).slice()
    corrupt[10] = ~corrupt[10]!
    const out = await inflateRaw(corrupt, plain.length)
    expect(out).not.toEqual(plain)
  })

  test('rejects an output size past the limit', async () => {
    await expect(inflateRaw(new Uint8Array(4), 1024 ** 3)).rejects.toThrow(
      /256 MB/,
    )
  })
})

describe('inflateRawUnknownSize', () => {
  test('grows to fit', async () => {
    // 4x the compressed length is the first guess, so a highly compressible
    // input forces at least one doubling.
    const plain = new Uint8Array(200_000).fill(7)
    expect(await inflateRawUnknownSize(zlib(plain).subarray(2))).toEqual(plain)
  })

  test('agrees with the known-size path', async () => {
    const plain = bytes(50_000)
    const raw = zlib(plain).subarray(2)
    expect(await inflateRawUnknownSize(raw)).toEqual(
      await inflateRaw(raw, plain.length),
    )
  })
})

describe('inflateRawBatch', () => {
  /** Pack `blocks` the way a reader hands a run of file records over. */
  function pack(blocks: Uint8Array[]) {
    const total = blocks.reduce((a, b) => a + b.length, 0)
    const inputs = new Uint8Array(total)
    const offsets = new Uint32Array(blocks.length)
    const lengths = new Uint32Array(blocks.length)
    let at = 0
    for (const [i, block] of blocks.entries()) {
      inputs.set(block, at)
      offsets[i] = at
      lengths[i] = block.length
      at += block.length
    }
    return { inputs, offsets, lengths }
  }

  test('inflates a run of blocks and brackets each one', async () => {
    const plains = [bytes(1000, 1), bytes(5000, 2), bytes(300, 3)]
    const { inputs, offsets, lengths } = pack(plains.map(zlib))

    const max = Math.max(...plains.map(p => p.length))
    const { data, offsets: out } = await inflateRawBatch(
      inputs,
      offsets,
      lengths,
      max,
    )

    expect(out).toHaveLength(plains.length + 1)
    for (const [i, plain] of plains.entries()) {
      expect(data.subarray(out[i], out[i + 1])).toEqual(plain)
    }
  })

  test('handles a single block, and an empty batch', async () => {
    const plain = bytes(2048)
    const one = pack([zlib(plain)])
    const single = await inflateRawBatch(
      one.inputs,
      one.offsets,
      one.lengths,
      plain.length,
    )
    expect(single.data.subarray(single.offsets[0], single.offsets[1])).toEqual(
      plain,
    )

    const none = await inflateRawBatch(
      new Uint8Array(0),
      new Uint32Array(0),
      new Uint32Array(0),
      1024,
    )
    expect(none.offsets).toEqual([0])
    expect(none.data).toHaveLength(0)
  })

  test('matches the one-at-a-time path', async () => {
    const plains = Array.from({ length: 16 }, (_, i) => bytes(1000 + i * 97, i))
    const compressed = plains.map(zlib)
    const { inputs, offsets, lengths } = pack(compressed)
    const max = Math.max(...plains.map(p => p.length))

    const batched = await inflateRawBatch(inputs, offsets, lengths, max)
    for (const [i, block] of compressed.entries()) {
      expect(
        batched.data.subarray(batched.offsets[i], batched.offsets[i + 1]),
      ).toEqual(await inflateRaw(block.subarray(2), plains[i]!.length))
    }
  })

  test('rejects a block that runs past the input buffer', async () => {
    const plain = bytes(1000)
    const { inputs, offsets } = pack([zlib(plain)])
    await expect(
      inflateRawBatch(
        inputs,
        offsets,
        new Uint32Array([inputs.length + 100]),
        4096,
      ),
    ).rejects.toThrow(/past the input buffer/)
  })

  test('rejects a block shorter than the zlib header', async () => {
    await expect(
      inflateRawBatch(
        new Uint8Array(8),
        new Uint32Array([0]),
        new Uint32Array([1]),
        1024,
      ),
    ).rejects.toThrow(/shorter than the 2-byte zlib header/)
  })

  test('rejects mismatched offset and length arrays', async () => {
    await expect(
      inflateRawBatch(
        new Uint8Array(8),
        new Uint32Array([0, 1]),
        new Uint32Array([1]),
        1024,
      ),
    ).rejects.toThrow(/differ in length/)
  })
})
