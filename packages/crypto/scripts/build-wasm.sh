#!/bin/sh
set -eu
cd "$(dirname "$0")/../native"
CARGO_BIN="${CARGO:-}"
if [ -z "$CARGO_BIN" ] && command -v rustup >/dev/null 2>&1; then
  CARGO_BIN="$(rustup which cargo)"
  RUSTC="$(rustup which rustc)"
  export RUSTC
fi
CARGO_BIN="${CARGO_BIN:-cargo}"
RUSTFLAGS="${RUSTFLAGS:-}" "$CARGO_BIN" build --release --target wasm32-unknown-unknown
mkdir -p ../wasm
cp target/wasm32-unknown-unknown/release/agent_bridge_noise.wasm ../wasm/noise.wasm
ls -l ../wasm/noise.wasm
