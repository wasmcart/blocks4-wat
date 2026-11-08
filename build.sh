#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
npx --yes --package wabt wat2wasm game.wat -o game.wasm
# no --version: wasmcart-pack 0.39.0 or later takes it from the git tags
# (the tag at a clean v<semver> tag, else <last tag>-dev.g<commit>)
npx --yes wasmcart pack --wasm game.wasm --name "Blocks 4 WAT" \
  --width 1280 --height 720 --controls dpad,a,b,x,y,start \
  -o blocks4-wat.wasc
echo "Built blocks4-wat.wasc"
