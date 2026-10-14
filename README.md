# @gmod/inflate

[![NPM version](https://img.shields.io/npm/v/@gmod/inflate.svg?style=flat-square)](https://npmjs.org/package/@gmod/inflate)
![Build Status](https://img.shields.io/github/actions/workflow/status/GMOD/inflate-js/publish.yml?branch=main)

DEFLATE decompression through a wasm
[libdeflate](https://github.com/ebiggers/libdeflate) build, shipped as one
self-contained bundle with the wasm inlined as base64 — no separate `.wasm`
fetch, no build tooling for consumers.

`@gmod/inflate` targets **a file holding hundreds of separately compressed
blocks.** `inflateRawBatch` inflates a whole run of them in a single JS↔wasm
crossing, and is roughly 4x faster than pako on the block sizes genomics formats
use.

## Install

    $ npm install @gmod/inflate

## Usage

```js
import { inflateRaw, inflateRawBatch } from '@gmod/inflate'

// One block, size known from an index
const plain = await inflateRaw(rawDeflateBytes, uncompressedSize)

// A run of blocks packed in one buffer — one crossing for all of them
const { data, offsets } = await inflateRawBatch(
  buffer, // concatenated compressed bytes
  new Uint32Array([0, 512, 1400]), // where each block starts
  new Uint32Array([512, 888, 640]), // how long each is
  65536, // the largest any one inflates to
)
for (let i = 0; i < offsets.length - 1; i++) {
  const block = data.subarray(offsets[i], offsets[i + 1])
}
```

The package instantiates the wasm module lazily on the first call and reuses it
from then on, so there is nothing to initialize and no teardown.

## API

### `inflateRaw(input, outputSize): Promise<Uint8Array>`

Inflates one **raw deflate** stream whose uncompressed size is already known.

- libdeflate writes straight into an exactly-sized buffer, with no growth loop
  and no streaming state.
- Formats that record the uncompressed size in their index, such as bigwig,
  `.hic` and bgzf, can always use it.

`input` must not include a zlib header. If your bytes start with one (`0x78`),
pass `input.subarray(2)`.

### `inflateRawUnknownSize(input): Promise<Uint8Array>`

Inflates one raw deflate stream whose size is not recorded. It doubles a guess
until the output fits, which costs a re-inflate per doubling. Prefer
`inflateRaw` where you can.

### `inflateRawBatch(inputs, offsets, lengths, maxBlockSize): Promise<BatchResult>`

Inflates many blocks in one call.

- `inputs` is the concatenated compressed bytes.
- `offsets` and `lengths` (both `Uint32Array`) locate each block within it.
- `maxBlockSize` is the largest size any single block inflates to.
- Unlike `inflateRaw`, it expects each block to start with a 2-byte zlib header,
  which the wasm skips.
- It returns `{ data, offsets }`. `data` is every block's bytes concatenated,
  and `offsets` has `blocks + 1` marks, so block `i` is
  `data.subarray(offsets[i], offsets[i + 1])`.

## Integrity

Raw deflate has **no checksum**. zlib stores its adler32 in the 4-byte trailer,
which these functions skip.

- Corruption that still forms a legal bit stream decodes to the wrong bytes with
  no error.
- For integrity, check the container's own data: bgzf's per-block CRC, or the
  uncompressed size an index recorded.
- On corrupt input that is _not_ a legal stream, the promise rejects, and the
  wasm instance stays usable for later calls.

## Why not `DecompressionStream`?

For a single large buffer, `DecompressionStream` is fine. For many small blocks,
its fixed per-call overhead dominates, and a caller pays it once per block. We
measured the overhead in three GMOD parsers, and the cost depends on how the
container packs its blocks:

| container                                                                                                 | blocks                       | vs wasm |
| --------------------------------------------------------------------------------------------------------- | ---------------------------- | ------: |
| [bigwig](https://github.com/GMOD/bbi-js/blob/main/docs/wasm.md#why-not-the-platforms-decompressionstream) | hundreds of small blocks     |   4-11x |
| [.hic](https://github.com/GMOD/hic/blob/main/docs/optimizations.md)                                       | fewer, larger blocks         |   ~2-7x |
| [bgzf](https://github.com/GMOD/bgzf-filehandle/blob/main/docs/optimizations.md)                           | concatenated members, 1 call |     ~2x |

`inflateRawBatch` pays the per-call cost once for the whole group.

`DecompressionStream` is also only
[baseline since May 2023](https://web.dev/blog/compressionstreams) (Safari 16.4,
Firefox 113), so a JS fallback ships regardless, and switching would not shrink
the bundle.

## Building

Git tracks the generated wasm bundle, so installing needs no Rust toolchain.
[CONTRIBUTING.md](CONTRIBUTING.md) covers rebuilding it.

## License

MIT
