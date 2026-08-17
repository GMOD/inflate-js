use libdeflater::Decompressor;
use wasm_bindgen::prelude::*;

const ZLIB_HEADER_SIZE: usize = 2;

/// Upper bound on what one call may allocate, so a corrupt length cannot ask
/// for the whole address space before failing.
const MAX_OUTPUT: usize = 256 * 1024 * 1024;

/// Slice out one block's raw deflate stream, skipping the 2-byte zlib header so
/// libdeflater's raw-deflate path can be used. Returns an error rather than
/// panicking on a corrupt offset/length: the crate builds with `panic = "abort"`,
/// so an out-of-bounds index would trap and leave the wasm instance unusable for
/// every later call instead of surfacing a catchable JS error.
fn deflate_block(inputs: &[u8], offset: u32, length: u32) -> Result<&[u8], JsError> {
    let len = (length as usize)
        .checked_sub(ZLIB_HEADER_SIZE)
        .ok_or_else(|| JsError::new("block is shorter than the 2-byte zlib header"))?;
    let start = (offset as usize)
        .checked_add(ZLIB_HEADER_SIZE)
        .ok_or_else(|| JsError::new("block offset overflows"))?;
    inputs
        .get(start..)
        .and_then(|rest| rest.get(..len))
        .ok_or_else(|| JsError::new("compressed block extends past the input buffer"))
}

/// Inflate one raw deflate stream whose decompressed size is already known.
///
/// The known-size path is the whole reason to prefer libdeflate here: it writes
/// straight into an exactly-sized buffer with no growth loop and no streaming
/// state. Formats that record the uncompressed size in their index — bigwig,
/// `.hic` — can always use this one.
#[wasm_bindgen]
pub fn inflate_raw(input: &[u8], output_size: usize) -> Result<Vec<u8>, JsError> {
    if output_size > MAX_OUTPUT {
        return Err(JsError::new("output_size exceeds the 256 MB limit"));
    }
    let mut decompressor = Decompressor::new();
    let mut output = vec![0u8; output_size];
    let actual = decompressor
        .deflate_decompress(input, &mut output)
        .map_err(|e| JsError::new(&format!("decompression failed: {:?}", e)))?;
    output.truncate(actual);
    Ok(output)
}

/// Inflate one raw deflate stream of unknown decompressed size.
///
/// Doubles a guess until it fits, so it costs a re-inflate per doubling. Prefer
/// `inflate_raw` wherever the size is recorded.
#[wasm_bindgen]
pub fn inflate_raw_unknown_size(input: &[u8]) -> Result<Vec<u8>, JsError> {
    let mut decompressor = Decompressor::new();
    let mut size = input.len().saturating_mul(4).max(1024);

    loop {
        let mut output = vec![0u8; size];
        match decompressor.deflate_decompress(input, &mut output) {
            Ok(actual_size) => {
                output.truncate(actual_size);
                return Ok(output);
            }
            Err(libdeflater::DecompressionError::InsufficientSpace) => {
                size *= 2;
                if size > MAX_OUTPUT {
                    return Err(JsError::new("decompression output too large"));
                }
            }
            Err(e) => {
                return Err(JsError::new(&format!("decompression failed: {:?}", e)));
            }
        }
    }
}

/// Inflate many zlib blocks packed into one buffer, in a single call.
///
/// This is the entry point that earns the wasm bundle. A JS caller pays the
/// JS↔wasm boundary once for the whole group instead of once per block, which
/// is what separates this from `DecompressionStream` — that API has no bulk
/// shape, so a format storing hundreds of separately-compressed blocks pays its
/// fixed per-call cost hundreds of times.
///
/// `inputs` is the concatenated compressed bytes; `input_offsets`/`input_lengths`
/// locate each block within it, and each block is expected to carry its 2-byte
/// zlib header (skipped internally). `max_block_size` is the largest size any
/// single block inflates to.
///
/// Returns one packed buffer, little-endian:
/// `[num_blocks: u32][offsets: u32 * (num_blocks + 1)][data]`, where consecutive
/// offsets bracket each block's bytes within `data`.
#[wasm_bindgen]
pub fn inflate_raw_batch(
    inputs: &[u8],
    input_offsets: &[u32],
    input_lengths: &[u32],
    max_block_size: u32,
) -> Result<Box<[u8]>, JsError> {
    if input_offsets.len() != input_lengths.len() {
        return Err(JsError::new("input_offsets and input_lengths differ in length"));
    }

    let mut decompressor = Decompressor::new();
    let num_blocks = input_offsets.len();
    let max_out = max_block_size as usize;

    let header_size = 4 + (num_blocks + 1) * 4;

    // Each block decompresses to at most max_out bytes, so num_blocks * max_out
    // is a true upper bound on the concatenated output. Reserving the real bound
    // (rather than a compression-ratio guess) means result never re-allocates,
    // avoiding a transient spike in the grow-only wasm heap.
    let max_output = num_blocks
        .checked_mul(max_out)
        .filter(|n| *n <= MAX_OUTPUT)
        .ok_or_else(|| JsError::new("num_blocks * max_block_size exceeds the 256 MB limit"))?;
    let mut result = Vec::with_capacity(header_size + max_output);
    result.resize(header_size, 0);

    result[0..4].copy_from_slice(&(num_blocks as u32).to_le_bytes());

    let offsets_start = 4;
    let mut data_offset = 0u32;

    let mut temp_buf = vec![0u8; max_out];

    for i in 0..num_blocks {
        let input = deflate_block(inputs, input_offsets[i], input_lengths[i])?;

        let offset_pos = offsets_start + i * 4;
        result[offset_pos..offset_pos + 4].copy_from_slice(&data_offset.to_le_bytes());

        let actual_size = decompressor
            .deflate_decompress(input, &mut temp_buf)
            .map_err(|e| JsError::new(&format!("decompression failed: {:?}", e)))?;

        result.extend_from_slice(&temp_buf[..actual_size]);
        data_offset += actual_size as u32;
    }

    let final_offset_pos = offsets_start + num_blocks * 4;
    result[final_offset_pos..final_offset_pos + 4].copy_from_slice(&data_offset.to_le_bytes());

    Ok(result.into_boxed_slice())
}
