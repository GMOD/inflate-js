# @gmod/inflate

[![NPM version](https://img.shields.io/npm/v/@gmod/inflate.svg?style=flat-square)](https://npmjs.org/package/@gmod/inflate)
![Build Status](https://img.shields.io/github/actions/workflow/status/GMOD/inflate-js/publish.yml?branch=main)

DEFLATE decompression through a wasm
[libdeflate](https://github.com/ebiggers/libdeflate) build, shipped as one
self-contained bundle with the wasm inlined as base64 — no separate `.wasm`
fetch, no build tooling for consumers.

It exists for one shape in particular: **a file holding hundreds of separately
compressed blocks.** `inflateRawBatch` inflates a whole run of them in a single
JS↔wasm crossing, which is what the platform's `DecompressionStream` cannot do,
and roughly 4x faster than pako on the block sizes genomics formats use.

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

The wasm module instantiates lazily on the first call and is shared from then
on, so there is nothing to initialize and no teardown.

## API

### `inflateRaw(input, outputSize): Promise<Uint8Array>`

One **raw deflate** stream whose uncompressed size is already known. This is the
path worth reaching for: libdeflate writes straight into an exactly-sized buffer
with no growth loop and no streaming state. Formats that record the uncompressed
size in their index — bigwig, `.hic`, bgzf — can always use it.

`input` must not include a zlib header. If your bytes start with one (`0x78`),
pass `input.subarray(2)`.

### `inflateRawUnknownSize(input): Promise<Uint8Array>`

The same, when the size is not recorded. Doubles a guess until it fits, so it
costs a re-inflate per doubling. Prefer `inflateRaw` where you can.

### `inflateRawBatch(inputs, offsets, lengths, maxBlockSize): Promise<BatchResult>`

Many blocks, one call. `inputs` is the concatenated compressed bytes and
`offsets`/`lengths` (both `Uint32Array`) locate each block within it.
`maxBlockSize` is the largest size any single block inflates to.

Unlike `inflateRaw`, each block here **is** expected to carry its 2-byte zlib
header; the wasm skips it internally.

Returns `{ data, offsets }`, where `data` is every block's bytes concatenated
and `offsets` has `blocks + 1` marks, so block `i` is
`data.subarray(offsets[i], offsets[i + 1])`.

## Integrity

Raw deflate carries **no checksum** — zlib's adler32 lives in the 4-byte trailer
these entry points skip past. A corruption that still forms a legal bit stream
decodes to the wrong bytes without an error. Callers needing integrity should
take it from their container: bgzf's per-block CRC, or a mismatch against the
uncompressed size an index recorded.

Corrupt input that is _not_ a legal stream rejects normally, and the wasm
instance stays usable for later calls.

## Why not `DecompressionStream`?

The platform has had one since 2023, and for a single large buffer it is a fine
answer. For a file of many small blocks it is not: its cost is dominated by a
fixed per-call overhead, and a caller must reach it once per block. Measured
across three GMOD parsers, the container's shape decides the result:

| container                                                                                                 | shape                        | vs wasm |
| --------------------------------------------------------------------------------------------------------- | ---------------------------- | ------: |
| [bigwig](https://github.com/GMOD/bbi-js/blob/main/docs/wasm.md#why-not-the-platforms-decompressionstream) | hundreds of small blocks     |   4-11x |
| [.hic](https://github.com/GMOD/hic/blob/main/docs/optimizations.md)                                       | fewer, larger blocks         |   ~2-7x |
| [bgzf](https://github.com/GMOD/bgzf-filehandle/blob/main/docs/optimizations.md)                           | concatenated members, 1 call |     ~2x |

`inflateRawBatch` is the answer to that per-call cost: it pays the crossing once
for the whole group.

It is also only
[baseline since May 2023](https://web.dev/blog/compressionstreams) (Safari 16.4,
Firefox 113), so a fallback ships regardless — which removes the one remaining
argument for it, the bundle saving.

## Building

The tracked `src/wasm/inflate-wasm-inlined.js` is generated, and rebuilding it
needs a Rust toolchain plus `wasm-bindgen-cli`:

    $ pnpm build:wasm

It must rebuild byte-for-byte — `preversion` runs `pnpm build`, so a
non-reproducible bundle would mean `npm version` quietly committing an artifact
nobody reviewed, part-way through a release. `git status` clean after
`pnpm build:wasm` is the check.

## License

MIT
