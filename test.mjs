import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const wasm = await readFile(new URL('./game.wasm', import.meta.url));

async function makeGame() {
  const { instance } = await WebAssembly.instantiate(wasm);
  const e = instance.exports;
  assert.equal(e.wc_get_info(), 0);
  assert.deepEqual([...new Uint32Array(e.memory.buffer).slice(0, 3)], [3, 1280, 720]);
  e.wc_init();
  return {
    e,
    board: new Uint8Array(e.memory.buffer, 3740000, 200),
    buttons: new Uint16Array(e.memory.buffer, 96, 1),
  };
}

function tap(game, button) {
  game.buttons[0] = button;
  game.e.wc_render();
  game.buttons[0] = 0;
  game.e.wc_render();
}

function softDrop(game) {
  const bagPosition = game.e.debug_bag_position.value;
  game.buttons[0] = 512;
  for (let frame = 0; frame < 120; frame++) {
    game.e.wc_render();
    if (game.e.debug_bag_position.value !== bagPosition) {
      game.buttons[0] = 0;
      game.e.wc_render();
      return;
    }
  }
  throw new Error('Down did not drop and lock the piece');
}

// Up rotates clockwise and the I piece kicks two cells away from the wall.
{
  const game = await makeGame();
  tap(game, 256);
  assert.equal(game.e.debug_rotation.value, 1, 'Up did not rotate clockwise');
  game.e.debug_piece.value = 0;
  game.e.debug_rotation.value = 1;
  game.e.debug_x.value = -2;
  game.e.debug_y.value = 5;
  tap(game, 1);
  assert.equal(game.e.debug_rotation.value, 2, 'wall rotation failed');
  assert.equal(game.e.debug_x.value, 0, 'two-cell wall kick failed');
}

// B rotates counter-clockwise; it never drops or locks the piece.
{
  const game = await makeGame();
  const y = game.e.debug_y.value;
  tap(game, 2);
  assert.equal(game.e.debug_rotation.value, 3);
  assert.equal(game.e.debug_y.value, y);
  assert.equal(game.board.some(Boolean), false);
}

// Down advances the piece at soft-drop speed.
{
  const game = await makeGame();
  for (let i = 0; i < 10; i++) game.e.wc_render();
  assert.equal(game.e.debug_y.value, -1, 'normal gravity is too fast');
  game.buttons[0] = 512;
  for (let i = 0; i < 4; i++) game.e.wc_render();
  game.buttons[0] = 0;
  assert.ok(game.e.debug_y.value >= 1, 'Down did not accelerate descent');
}

// A grounded piece remains controllable for 30 frames before it locks.
{
  const game = await makeGame();
  game.e.debug_y.value = 18;
  for (let i = 0; i < 29; i++) game.e.wc_render();
  assert.equal(game.board.some(Boolean), false, 'piece locked before the lock delay elapsed');
  assert.equal(game.e.debug_lock_timer.value, 29);
  game.e.wc_render();
  assert.equal(game.board.some(Boolean), true, 'piece did not lock after the lock delay');
}

// Restart consumes A instead of rotating the new piece in the same frame.
{
  const game = await makeGame();
  game.e.debug_game_over.value = 1;
  tap(game, 1);
  assert.equal(game.e.debug_game_over.value, 0);
  assert.equal(game.e.debug_rotation.value, 0);
}

// The first bag contains each of the seven pieces exactly once.
{
  const game = await makeGame();
  const bag = [];
  for (let i = 0; i < 7; i++) {
    bag.push(game.e.debug_piece.value);
    softDrop(game);
    game.board.fill(0);
  }
  assert.deepEqual([...new Set(bag)].sort(), [0, 1, 2, 3, 4, 5, 6]);
}

// A full row clears on lock and advances the line counter.
{
  const game = await makeGame();
  game.board.fill(1, 190, 200);
  softDrop(game);
  assert.ok([...game.board.slice(190, 200)].filter(Boolean).length < 10);
  assert.equal(game.e.debug_lines.value, 1);
  const words = new Uint32Array(game.e.memory.buffer);
  assert.ok(words[20] >= 1600, 'audio cursor did not advance');
  const audio = new Float32Array(game.e.memory.buffer, 3700000, 8192);
  assert.ok(audio.some((sample) => sample !== 0), 'audio ring is silent');
}

function fits(board, mask, ox, oy) {
  for (let i = 0; i < 16; i++) {
    if (!((mask >>> i) & 1)) continue;
    const x = ox + (i & 3);
    const y = oy + (i >>> 2);
    if (x < 0 || x >= 10 || y >= 20 || (y >= 0 && board[y * 10 + x])) return false;
  }
  return true;
}

function candidate(board, mask, x) {
  let y = -4;
  while (fits(board, mask, x, y + 1)) y++;
  const next = Uint8Array.from(board);
  for (let i = 0; i < 16; i++) {
    if (!((mask >>> i) & 1)) continue;
    const py = y + (i >>> 2);
    const px = x + (i & 3);
    if (py < 0 || px < 0 || px >= 10) return null;
    next[py * 10 + px] = 1;
  }
  let cleared = 0;
  for (let row = 19; row >= 0; row--) {
    if (next.slice(row * 10, row * 10 + 10).every(Boolean)) {
      next.copyWithin(10, 0, row * 10);
      next.fill(0, 0, 10);
      cleared++;
      row++;
    }
  }
  const heights = [];
  let holes = 0;
  for (let col = 0; col < 10; col++) {
    let top = 20;
    for (let row = 0; row < 20; row++) {
      if (next[row * 10 + col]) { top = row; break; }
    }
    heights.push(20 - top);
    for (let row = top + 1; row < 20; row++) if (!next[row * 10 + col]) holes++;
  }
  const bump = heights.slice(1).reduce((n, h, i) => n + Math.abs(h - heights[i]), 0);
  const value = cleared * 1000 - holes * 120 - heights.reduce((a, b) => a + b, 0) * 5
    - Math.max(...heights) * 10 - bump * 4;
  return { value };
}

// Controller-driven playthrough: choose placements, rotate and move through
// the real input ABI, then soft-drop thirty consecutive pieces with Down.
{
  const game = await makeGame();
  const masks = new Uint16Array(game.e.memory.buffer, 3741000, 28);
  for (let turn = 0; turn < 30; turn++) {
    const piece = game.e.debug_piece.value;
    let best = null;
    for (let rot = 0; rot < 4; rot++) {
      const mask = masks[piece * 4 + rot];
      for (let x = -2; x < 10; x++) {
        const result = candidate(game.board, mask, x);
        if (result && (!best || result.value > best.value)) best = { ...result, rot, x };
      }
    }
    assert.ok(best, `no legal placement on turn ${turn}`);
    for (let i = 0; i < best.rot; i++) tap(game, 1);
    while (game.e.debug_x.value > best.x) tap(game, 1024);
    while (game.e.debug_x.value < best.x) tap(game, 2048);
    softDrop(game);
    assert.equal(game.e.debug_game_over.value, 0, `game over on turn ${turn}`);
  }
  assert.ok(game.e.debug_lines.value >= 2, 'playthrough never completed lines');
}

console.log('blocks4-wat: Tetris rules and 30-piece controller playthrough passed');
