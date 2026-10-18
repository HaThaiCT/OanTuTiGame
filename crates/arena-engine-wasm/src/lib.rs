//! WASM surface for the OanTuTi engine.
//!
//! Two exports serve the browser/verification tooling:
//!
//! * `oantuti_proximity` — GP-02 proximity for one piece (visualization/replay UI).
//! * `oantuti_verify_replay` — the *same* replay loop as the native `verify-trace` binary,
//!   reached through the shared `arena_verifier` front-end, so a browser verifies an
//!   official trace without reimplementing the rules.
//!
//! Memory ABI for the verifier: the caller writes a UTF-8 JSON document into memory obtained
//! from `oantuti_alloc`, then calls `oantuti_verify_replay(ptr, len)`. The returned pointer
//! starts a little-endian `u32` length followed by that many UTF-8 bytes; the caller releases
//! it with `oantuti_result_free(ptr)` (length prefix included) and its input buffer with
//! `oantuti_free(ptr, len)`.

use std::alloc::{alloc, dealloc, Layout};
use std::ptr;

use arena_engine::proximity_contribution;

/// GP-02 proximity for one piece; exported to browser replay/visualization.
#[no_mangle]
pub extern "C" fn oantuti_proximity(distance: u32) -> u32 {
    proximity_contribution(distance as i32) as u32
}

/// Allocates `len` bytes (at least one) for a caller-provided input document.
#[no_mangle]
pub extern "C" fn oantuti_alloc(len: usize) -> *mut u8 {
    let layout = Layout::from_size_align(len.max(1), 1).expect("valid allocation layout");
    // SAFETY: `layout` has a non-zero size, as required by `alloc`.
    unsafe { alloc(layout) }
}

/// Releases a buffer previously returned by [`oantuti_alloc`].
#[no_mangle]
pub extern "C" fn oantuti_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let layout = Layout::from_size_align(len.max(1), 1).expect("valid allocation layout");
    // SAFETY: the pointer came from `oantuti_alloc` with the same layout.
    unsafe { dealloc(ptr, layout) }
}

/// Verifies one JSON trace document and returns a length-prefixed result buffer.
///
/// The payload is a UTF-8 JSON line shaped exactly like the native CLI's stdout:
/// `{"ok":true,"appliedPly":…,"winner":…,"reason":…}` or `{"ok":false,"error":"…"}`.
#[no_mangle]
pub extern "C" fn oantuti_verify_replay(ptr: *const u8, len: usize) -> *mut u8 {
    let input: &[u8] = if ptr.is_null() || len == 0 {
        &[]
    } else {
        // SAFETY: the caller guarantees `len` readable bytes at `ptr` for the duration of the call.
        unsafe { std::slice::from_raw_parts(ptr, len) }
    };
    let (line, _code) = arena_verifier::verify_line(input);
    let bytes = line.into_bytes();
    let mut framed = Vec::with_capacity(bytes.len() + 4);
    framed.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    framed.extend_from_slice(&bytes);
    Box::into_raw(framed.into_boxed_slice()) as *mut u8
}

/// Reads the little-endian `u32` length prefix of a result buffer.
fn result_len(ptr: *const u8) -> usize {
    // SAFETY: every result buffer starts with a 4-byte length prefix.
    let prefix = unsafe { std::slice::from_raw_parts(ptr, 4) };
    u32::from_le_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize
}

/// Releases a result buffer returned by [`oantuti_verify_replay`].
#[no_mangle]
pub extern "C" fn oantuti_result_free(ptr: *mut u8) {
    if ptr.is_null() {
        return;
    }
    let total = result_len(ptr) + 4;
    // SAFETY: the pointer/length pair came from `oantuti_verify_replay`'s boxed slice.
    unsafe {
        drop(Box::from_raw(ptr::slice_from_raw_parts_mut(ptr, total) as *mut [u8]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Copies a result buffer into a `String` and frees it.
    fn take_result(ptr: *mut u8) -> String {
        let len = result_len(ptr);
        // SAFETY: the result buffer holds `len` readable bytes after its 4-byte prefix.
        let bytes = unsafe { std::slice::from_raw_parts(ptr.add(4), len) }.to_vec();
        oantuti_result_free(ptr);
        String::from_utf8(bytes).expect("utf-8 result")
    }

    #[test]
    fn alloc_free_round_trip() {
        let buffer = oantuti_alloc(16);
        assert!(!buffer.is_null());
        oantuti_free(buffer, 16);
    }

    #[test]
    fn verify_replay_rejects_missing_outcome_without_panicking() {
        let document = br#"{"manifest":{"game_id":"g","map":{"mapName":"m","width":1,"height":1,"validTiles":[[0,0]],"whiteThrone":[0,0],"blackThrone":[0,0]},"pieces":[],"max_ply":1},"actions":[],"outcome":null}"#;
        let result = take_result(oantuti_verify_replay(document.as_ptr(), document.len()));
        assert!(result.contains("\"ok\":false"), "{result}");
        assert!(result.contains("MISSING_CLAIMED_OUTCOME"), "{result}");
    }

    #[test]
    fn verify_replay_accepts_a_throne_breach_trace() {
        let document = br#"{"manifest":{"game_id":"g","map":{"mapName":"m","width":3,"height":3,
            "validTiles":[[0,0],[1,0],[2,0],[0,1],[1,1],[2,1],[0,2],[1,2],[2,2]],
            "whiteThrone":[0,0],"blackThrone":[2,2]},
            "pieces":[{"id":1,"owner":"WHITE","piece_type":"ROCK","pos":{"x":1,"y":2},"is_alive":true},
                      {"id":2,"owner":"BLACK","piece_type":"ROCK","pos":{"x":0,"y":2},"is_alive":true}],
            "max_ply":10},"actions":[{"piece_id":1,"target_pos":[2,2],"side":"WHITE"}],
            "outcome":{"winner":"WHITE","reason":"THRONE_BREACH"}}"#;
        let result = take_result(oantuti_verify_replay(document.as_ptr(), document.len()));
        assert!(result.contains("\"ok\":true"), "{result}");
        assert!(result.contains("\"appliedPly\":1"), "{result}");
        assert!(result.contains("\"reason\":\"THRONE_BREACH\""), "{result}");
    }
}
