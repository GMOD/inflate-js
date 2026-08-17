export {
  inflateRaw,
  inflateRawBatch,
  inflateRawUnknownSize,
} from './wasm/inflate-wasm-inlined.js'

/**
 * Declared here rather than re-exported from the bundle: webpack emits plain
 * JS, so an interface written in `crate/src/wrapper.ts` does not survive into
 * it, and tsc's inference over the generated file cannot recover one.
 */
export interface BatchResult {
  /** Every block's bytes, concatenated. */
  data: Uint8Array
  /** `blocks + 1` marks; block `i` is `data.subarray(offsets[i], offsets[i + 1])`. */
  offsets: number[]
}
