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
# Newer rustc no longer passes --allow-undefined to the wasm32-unknown-unknown
# linker, so host imports (host_random) must be allowed explicitly.
RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=--allow-undefined" \
  "$CARGO_BIN" build --release --target wasm32-unknown-unknown
mkdir -p ../wasm
cp target/wasm32-unknown-unknown/release/agent_bridge_noise.wasm ../wasm/noise.wasm
ls -l ../wasm/noise.wasm
