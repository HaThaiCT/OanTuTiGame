#!/usr/bin/env bash
# Builds the browser-side replay verifier (`crates/arena-engine-wasm`) for
# wasm32-unknown-unknown and places the module where Next.js serves static assets.
#
# Usage: deploy/linux/build-wasm-verifier.sh
#
# Environment (all optional except an offline Cargo cache):
#   CARGO_BIN      cargo binary to use              (default: cargo from PATH)
#   TOOLCHAIN_BIN  directory holding cargo/rustc    (prepended to PATH)
#   CARGO_HOME     Cargo home with cached crates    (required when building offline)
#   PROTOC         protoc binary                    (only needed for protobuf crates)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

if [[ -n "${TOOLCHAIN_BIN:-}" ]]; then
  export PATH="${TOOLCHAIN_BIN}:${PATH}"
fi
cargo_bin="${CARGO_BIN:-cargo}"

"${cargo_bin}" build -p arena-engine-wasm --target wasm32-unknown-unknown --release --offline

mkdir -p packages/web/public/wasm
cp target/wasm32-unknown-unknown/release/arena_engine_wasm.wasm \
   packages/web/public/wasm/arena_engine_wasm.wasm
sha256sum packages/web/public/wasm/arena_engine_wasm.wasm
