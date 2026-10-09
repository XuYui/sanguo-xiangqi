/**
 * 落子交互测试
 *
 * 直接跑网页里的 resolveBoardClick（app.js 导出），不需要浏览器与屏幕坐标，
 * 因此可以稳稳地覆盖「选中 / 落子 / 取消 / 不该动的时候不动」四种分支。
 *
 * 导入的是应用源码（apps/web/public/app/app.js）。它顶层会调用 main()，
 * 但 main() 里发的 fetch 在 Node 下会失败并被 catch，不影响 resolveBoardClick；
 * 为了稳妥，这里先设一个最小的 DOM/fetch 桩。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// --- 最小 DOM 桩：app.js 顶层 main() 会在 await 第一个 fetch 时抛错并被 catch ---
const noop = () => {};
const fakeEl = {
  textContent: '',
  className: '',
  hidden: false,
  disabled: false,
  style: {},
  dataset: {},
  value: '',
  scrollTop: 0,
  scrollHeight: 0,
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop,
  appendChild: noop,
  append: noop,
  replaceChildren: noop,
  querySelector: () => null,
  querySelectorAll: () => [],
  setAttribute: noop,
  getAttribute: () => null,
  removeChild: noop,
  firstChild: null,
  innerHTML: '',
};
(globalThis as any).document = {
  getElementById: () => fakeEl,
  createElement: () => fakeEl,
  createElementNS: () => fakeEl,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop,
};
(globalThis as any).window = {
  io: () => ({ on: noop, emit: noop, close: noop, connected: false }),
  addEventListener: noop,
  devicePixelRatio: 1,
};
(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: noop,
  removeItem: noop,
};
(globalThis as any).location = { search: '', origin: 'http://localhost' };
(globalThis as any).history = { replaceState: noop };
(globalThis as any).fetch = () => Promise.reject(new Error('测试环境不联网'));

const { resolveBoardClick, shouldAcceptSnapshot } = await import('../../web/public/app/app.js');

/** 造一个最小对局：魏、蜀、吴各一帥，魏的中路兵在 (5,4) 可走到 (5,5) */
const game = {
  phase: 'playing',
  turn: 'wei',
  pieces: {
    'wei:5,4': { kind: 'soldier', owner: 'wei' },
    'shu:5,1': { kind: 'general', owner: 'shu' },
    'wu:5,1': { kind: 'general', owner: 'wu' },
    'wei:5,1': { kind: 'general', owner: 'wei' },
  },
};
const targets = [{ to: { player: 'wei', file: 5, rank: 5 } }];

test('点自己的子 -> 选中', () => {
  const r = resolveBoardClick(game, 'wei', null, [], 'wei:5,4');
  assert.deepEqual(r, { kind: 'select', from: 'wei:5,4' });
});

test('选中后点可走点 -> 落子', () => {
  const r = resolveBoardClick(game, 'wei', 'wei:5,4', targets, 'wei:5,5');
  assert.deepEqual(r, { kind: 'move', to: 'wei:5,5' });
});

test('没选中时点可走点 -> 不落子（避免误触）', () => {
  const r = resolveBoardClick(game, 'wei', null, targets, 'wei:5,5');
  assert.equal(r.kind, 'clear');
});

test('点别人的子 -> 取消选中（不是选中对方）', () => {
  const r = resolveBoardClick(game, 'wei', 'wei:5,4', targets, 'shu:5,1');
  assert.deepEqual(r, { kind: 'clear' });
});

test('点空点 -> 取消选中', () => {
  assert.deepEqual(resolveBoardClick(game, 'wei', 'wei:5,4', targets, 'wei:1,1'), {
    kind: 'clear',
  });
});

test('不是自己回合 -> 一律不动', () => {
  const shuTurn = { ...game, turn: 'shu' as const };
  for (const id of ['wei:5,4', 'wei:5,5', 'shu:5,1']) {
    const r = resolveBoardClick(shuTurn, 'wei', 'wei:5,4', targets, id);
    assert.equal(r.kind, 'ignore', `${id} 不该被响应`);
    assert.equal((r as { reason: string }).reason, 'notYourTurn');
  }
});

test('观战者（myPlayer=null）-> 一律不动', () => {
  const r = resolveBoardClick(game, null, null, targets, 'wei:5,4');
  assert.equal(r.kind, 'ignore');
});

test('对局已结束 -> 一律不动', () => {
  const over = { ...game, phase: 'finished' as const };
  const r = resolveBoardClick(over, 'wei', null, [], 'wei:5,4');
  assert.equal(r.kind, 'ignore');
  assert.equal((r as { reason: string }).reason, 'notPlaying');
});

test('没有对局（game=null）-> 不动', () => {
  const r = resolveBoardClick(null, 'wei', null, [], 'wei:5,4');
  assert.equal(r.kind, 'ignore');
});

test('选中后点自己另一个子 -> 切换选中（而不是落子）', () => {
  const g2 = {
    ...game,
    pieces: { ...game.pieces, 'wei:1,1': { kind: 'rook', owner: 'wei' } },
  };
  const r = resolveBoardClick(g2, 'wei', 'wei:5,4', targets, 'wei:1,1');
  assert.deepEqual(r, { kind: 'select', from: 'wei:1,1' });
});

test('旧快照不能覆盖当前回合，避免棋子短暂可点后又被锁住', () => {
  const current = { code: 'ROOM', version: 8, game: { turn: 'wei' } };
  assert.equal(shouldAcceptSnapshot(current, { code: 'ROOM', version: 7 }), false);
  assert.equal(shouldAcceptSnapshot(current, { code: 'ROOM', version: 8 }), false);
  assert.equal(shouldAcceptSnapshot(current, { code: 'ROOM', version: 9 }), true);
});

test('不同房间重新从低版本开始接收快照', () => {
  const current = { code: 'OLD', version: 8 };
  assert.equal(shouldAcceptSnapshot(current, { code: 'NEW', version: 0 }), true);
});
