import * as bg from '../wasm-bindgen/inflate_wasm_bg.js'
import wasmData from '../wasm-bindgen/inflate_wasm_bg.wasm'
import {
  inflate_raw,
  inflate_raw_batch,
  inflate_raw_unknown_size,
} from '../wasm-bindgen/inflate_wasm.js'

let wasm: WebAssembly.Exports | null = null
let initPromise: Promise<WebAssembly.Exports> | null = null

/**
 * Instantiate once per process, and share the in-flight promise so concurrent
 * first calls do not each instantiate a module.
 */
async function init(): Promise<WebAssembly.Exports> {
  if (wasm) {
    return wasm
  }
  initPromise ??= (async () => {
    const response = await fetch(wasmData)
    const bytes = await response.arrayBuffer()
    const { instance } = await WebAssembly.instantiate(bytes, {
      './inflate_wasm_bg.js': bg,
    })
    bg.__wbg_set_wasm(instance.exports)
    wasm = instance.exports
    return wasm
  })()
  return initPromise
}

export interface BatchResult {
  /** Every block's bytes, concatenated. */
  data: Uint8Array
  /** `num_blocks + 1` marks; block `i` is `data.subarray(offsets[i], offsets[i + 1])`. */
  offsets: number[]
}

export async function inflateRaw(
  input: Uint8Array,
  outputSize: number,
): Promise<Uint8Array> {
  await init()
  return inflate_raw(input, outputSize)
}

export async function inflateRawUnknownSize(
  input: Uint8Array,
): Promise<Uint8Array> {
  await init()
  return inflate_raw_unknown_size(input)
}

export async function inflateRawBatch(
  inputs: Uint8Array,
  inputOffsets: Uint32Array,
  inputLengths: Uint32Array,
  maxOutputSize: number,
): Promise<BatchResult> {
  await init()
  const packed = inflate_raw_batch(
    inputs,
    inputOffsets,
    inputLengths,
    maxOutputSize,
  )

  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength)
  const numBlocks = view.getUint32(0, true)
  const offsetsStart = 4
  const dataStart = offsetsStart + (numBlocks + 1) * 4

  const offsets = new Array<number>(numBlocks + 1)
  for (let i = 0; i <= numBlocks; i++) {
    offsets[i] = view.getUint32(offsetsStart + i * 4, true)
  }

  return { data: packed.subarray(dataStart), offsets }
}
