#!/usr/bin/env bash
# Smoke-test the published artifact shape by packing and importing.
#
# tsc only copies .ts -> .js, so non-ts assets (here src/wasm/*.js, the whole
# point of the package) are easy to leave out of esm/ and dist/. Plain
# `pnpm test` runs against src/ and cannot see the shape of the tarball at all
# — which is exactly how @gmod/bbi@9.0.11 shipped a wasm import that resolved
# to nothing. This script:
#   1. `npm pack`s the package
#   2. installs the tarball into a scratch dir
#   3. imports `@gmod/inflate` from both the ESM and CJS entry points
#   4. actually inflates something, to force the wasm bundle to instantiate
#   5. asserts the tarball carries no stray build intermediate and no
#      oversized .d.ts
#
# Any missing-asset / bad-export bug shows up as a non-zero exit here.

set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

cd "$PKG_DIR"
TARBALL="$(npm pack --silent --pack-destination "$SCRATCH")"

# The bundle is the artifact this package exists to ship; the webpack input it
# is built from is not, and landing that in src/ would publish it three times
# over with sourcemaps. Match the wrapper, not a broad `-inlined` glob, or this
# rejects the package for containing the very file it ships.
LISTING="$(tar tzf "$SCRATCH/$TARBALL")"
if grep -q 'package/src/wasm/wrapper\.js' <<<"$LISTING"; then
  echo "tarball carries the webpack input from crate/build/" >&2
  exit 1
fi
if ! grep -q 'package/esm/wasm/inflate-wasm-inlined\.js' <<<"$LISTING"; then
  echo "tarball is missing esm/wasm/inflate-wasm-inlined.js" >&2
  exit 1
fi
if ! grep -q 'package/dist/wasm/inflate-wasm-inlined\.js' <<<"$LISTING"; then
  echo "tarball is missing dist/wasm/inflate-wasm-inlined.js" >&2
  exit 1
fi

# A generated .d.ts over 32 KB means tsc inferred a string literal for the
# whole bundle and wrote it back out as a type. Every consumer's tsc then
# parses it.
while read -r size name; do
  if [ "$size" -gt 32768 ]; then
    echo "$name is $size bytes: a .d.ts that large is an inferred bundle literal" >&2
    exit 1
  fi
done < <(tar tzvf "$SCRATCH/$TARBALL" | awk '$NF ~ /\.d\.ts$/ {print $3, $NF}')

cd "$SCRATCH"
cat >package.json <<'JSON'
{
  "name": "inflate-pack-test",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
JSON
npm install --silent --no-audit --no-fund pako-esm2 "./$TARBALL" >/dev/null

# Round-trip a real deflate stream. Instantiating the wasm module is the part
# that a missing or mis-parsed bundle fails on, and only an actual call does it.
cat >fixture.mjs <<'JS'
import { deflate } from 'pako-esm2'
export const plain = new TextEncoder().encode('inflate '.repeat(4096))
export const zlib = deflate(plain)
export function same(a, b) {
  if (a.length !== b.length) throw new Error(`length ${a.length} != ${b.length}`)
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) throw new Error(`byte ${i} differs`)
  }
}
JS

cat >smoke.mjs <<'JS'
import { inflateRaw, inflateRawBatch, inflateRawUnknownSize } from '@gmod/inflate'
import { plain, zlib, same } from './fixture.mjs'
for (const [name, fn] of Object.entries({ inflateRaw, inflateRawBatch, inflateRawUnknownSize })) {
  if (typeof fn !== 'function') throw new Error(`${name} missing from ESM entry`)
}
// inflateRaw takes a bare deflate stream; the batch path skips the header itself
same(plain, await inflateRaw(zlib.subarray(2), plain.length))
const { data, offsets } = await inflateRawBatch(
  zlib, new Uint32Array([0]), new Uint32Array([zlib.length]), plain.length,
)
same(plain, data.subarray(offsets[0], offsets[1]))
console.log('esm: ok')
JS

cat >smoke.cjs <<'JS'
;(async () => {
  const { inflateRaw, inflateRawBatch, inflateRawUnknownSize } = require('@gmod/inflate')
  const { plain, zlib, same } = await import('./fixture.mjs')
  for (const [name, fn] of Object.entries({ inflateRaw, inflateRawBatch, inflateRawUnknownSize })) {
    if (typeof fn !== 'function') throw new Error(`${name} missing from CJS entry`)
  }
  same(plain, await inflateRaw(zlib.subarray(2), plain.length))
  console.log('cjs: ok')
})().catch(e => { console.error(e); process.exit(1) })
JS

node smoke.mjs
node smoke.cjs
