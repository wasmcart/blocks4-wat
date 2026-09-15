#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
npx --yes --package wabt wat2wasm game.wat -o game.wasm
npx --yes wasmcart pack --wasm game.wasm --name "Blocks 4 WAT" \
  --version 1.0.0 --width 1280 --height 720 --controls dpad,a,b,x,y,start \
  -o blocks4-wat.wasc
echo "Built blocks4-wat.wasc"
