#!/bin/sh
# Requires a toolchain that ships wasm32-unknown-unknown std (verified: 1.85-aarch64-apple-darwin).
# CARGO_HOME must point at a writable dir when the default one is read-only.
set -e
TC="${RUST_TOOLCHAIN_DIR:-$HOME/.rustup/toolchains/1.85-aarch64-apple-darwin/bin}"
CARGO_HOME="${CARGO_HOME:-$PWD/.cargo-home}" RUSTC="$TC/rustc" "$TC/cargo" build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/noise_wasm.wasm ../noise-interop/
