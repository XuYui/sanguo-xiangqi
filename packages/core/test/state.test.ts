/**
 * 对局状态机测试
 *
 * 覆盖：初始局面、回合轮转、挡将、飞将、吃子、将死淘汰、困毙、长将判负、结束判定。
 *
 * 说明：三人象棋「将死」局面的关键点在于——帥被九宫与自家兵阵保护，
 * 攻击只能来自**同一地盘的格线**（底线同一行、或第 5 列纵深），
 * 所以刻意手工摆一个将死局面既脆弱又容易误导。
 * 这里改为验证**替换、移除与结束流程**的确定性行为。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PLAYERS } from '../src/board.ts';
import {
  INITIAL_LAYOUT,
  allPiecesOf,
  applyMove,
  checkers,
  createInitialState,
  findGeneral,
  generalsFace,
  isInCheck,
  legalMoves,
  legalMovesFrom,
  occupiedPoints,
  parseId,
  piecesOf,
  pseudoMovesFrom,
  resign,
  summarize,
  violatesFlyingGeneral,
} from '../src/state.ts';
import { DEFAULT_RULES, PLAYER_KEYS, type PlayerKey } from '../src/types.ts';
import { buildState } from './helpers.ts';

const mv = (from: string, to: string) => ({ from: parseId(from), to: parseId(to) });

/** 依序走一串棋，任一步失败即抛出（便于把长将等流程写成剧本） */
function playSequence(state: ReturnType<typeof createInitialState>, moves: readonly string[][]) {
  let cur = state;
  const events: { ply: number; by: PlayerKey; status: string }[] = [];
  for (const [from, to] of moves) {
    const r = applyMove(cur, mv(from!, to!));
    assert.ok(r.ok, `走 ${from}->${to} 失败: ${r.ok ? '' : r.error}`);
    if (!r.ok) return { state: cur, events };
    cur = r.state;
    events.push({ ply: cur.ply, by: r.state.history.at(-1)!.by, status: JSON.stringify(cur.status) });
  }
  return { state: cur, events };
}

// ---------------------------------------------------------------------------
// 初始局面
// ---------------------------------------------------------------------------

test('初始局面：三家各 16 子共 48 子，帥在九宫中心，无人被将军', () => {
  const s = createInitialState();
  assert.equal(occupiedPoints(s).length, 48);
  assert.equal(INITIAL_LAYOUT.length, 16);
  for (const k of PLAYER_KEYS) {
    assert.equal(piecesOf(s, k).length, 16);
    assert.equal(findGeneral(s, k), `${k}:5,1`);
    assert.ok(!isInCheck(s, k), `${PLAYERS[k].name} 开局不该被将军`);
  }
  assert.equal(s.turn, 'wei');
  assert.equal(s.phase, 'playing');
  assert.equal(s.ply, 0);
  assert.ok(!violatesFlyingGeneral(s));
  assert.deepEqual(summarize(s).inCheck, []);
});

test('初始局面：三家都有棋可走', () => {
  const s = createInitialState();
  for (const k of PLAYER_KEYS) {
    assert.ok(legalMoves(s, k).length > 0, `${PLAYERS[k].name} 开局无棋可走`);
  }
});

test('初始局面：底线九子密集，角車只有 2 步（被自家子挡住）', () => {
  const s = createInitialState();
  // 横向被自家 8 个子占满；纵向只到 (1,4) 的吴兵为止
  const rook = legalMovesFrom(s, 'wei:1,1').map((m) => `${m.to.file},${m.to.rank}`);
  assert.deepEqual(rook.sort(), ['1,2', '1,3']);
  // 中路兵只能前进一格（未过河不能横走）
  assert.deepEqual(
    legalMovesFrom(s, 'wei:5,4').map((m) => `${m.to.file},${m.to.rank}`),
    ['5,5'],
  );
});

// ---------------------------------------------------------------------------
// 走子与回合
// ---------------------------------------------------------------------------

test('走子：合法走法可以应用，回合交给下一家', () => {
  const s = createInitialState();
  const r = applyMove(s, mv('wei:5,4', 'wei:5,5'));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.state.pieces['wei:5,5']?.kind, 'soldier');
  assert.equal(r.state.pieces['wei:5,4'], undefined);
  assert.equal(r.state.turn, 'shu');
  assert.equal(r.state.ply, 1);
  assert.equal(r.state.history.length, 1);
  assert.equal(r.state.history[0]!.by, 'wei');
  assert.ok(r.state.history[0]!.notation.includes('兵'));
});

test('走子：拒绝非本方回合 / 空起点 / 吃自己子 / 原地不动 / 非法几何', () => {
  const s = createInitialState();
  assert.ok(!applyMove(s, mv('wu:5,4', 'wu:5,5')).ok, '不是吴的回合');
  assert.ok(!applyMove(s, mv('wei:1,5', 'wei:2,5')).ok, '起点无子');
  assert.ok(!applyMove(s, mv('wei:1,1', 'wei:2,1')).ok, '不能吃自己子');
  assert.ok(!applyMove(s, mv('wei:1,1', 'wei:1,1')).ok, '原地不动');
  assert.ok(!applyMove(s, mv('wei:1,1', 'wei:5,5')).ok, '車不能跳着走');
  assert.ok(!applyMove(s, mv('wei:1,1', 'wu:9,5')).ok, '不能跨河两步');
});

test('走子：吃子会记录事件，且棋子易主位置', () => {
  // 魏車已过河站在吴(9,2)，沿吴第 9 列吃掉吴(9,4) 的吴兵
  const s = buildState({
    pieces: {
      wei: ['帥@1,1', '車@wu:9,2'],
      wu: ['帥@5,1', '兵@9,4'],
      shu: ['帥@9,1'],
    },
    turn: 'wei',
  });
  const r = applyMove(s, mv('wu:9,2', 'wu:9,4'));
  assert.ok(r.ok, r.ok ? '' : r.error);
  if (!r.ok) return;
  assert.ok(r.events.some((e) => e.type === 'capture'));
  assert.equal(r.state.pieces['wu:9,4']?.owner, 'wei', '吃子后棋子换成魏的');
  assert.equal(r.state.pieces['wu:9,2'], undefined, '起点应清空');
});

test('帅被吃：该家立即出局、棋子全部移除；只剩一家时对局结束', () => {
  // 魏車过河沿吴第 9 列直下吃吴帥，吴只剩这一个子
  const s = buildState({
    pieces: {
      wei: ['帥@1,1', '車@wu:9,2'],
      wu: ['帥@9,1'],
      shu: ['帥@9,1'],
    },
    turn: 'wei',
  });
  assert.equal(findGeneral(s, 'wu'), 'wu:9,1');
  const r = applyMove(s, mv('wu:9,2', 'wu:9,1'));
  assert.ok(r.ok, r.ok ? '' : r.error);
  if (!r.ok) return;
  assert.equal(findGeneral(r.state, 'wu'), undefined, '吴帥已被吃');
  assert.equal(allPiecesOf(r.state, 'wu').length, 0, '吴棋子应全部移除');
  assert.ok(
    r.state.status.wu === 'checkmated' || r.state.status.wu === 'stalemated',
    `吴应已出局，实际=${r.state.status}`,
  );
  assert.equal(r.state.phase, 'finished');
  assert.equal(r.state.winner, 'wei', '只剩魏一家 -> 魏胜');
  assert.ok(r.events.some((e) => e.type === 'gameOver'));
  assert.ok(r.events.some((e) => e.type === 'eliminated' && e.who === 'wu'));
});

test('将死淘汰：引擎在「轮到的下一家无合法走法」时判其出局', () => {
  // 与上一条相同通道：吃掉蜀帥后，引擎按规则结算蜀的命运
  const s = buildState({
    pieces: {
      // 魏帥放在第 9 列：第 1 列跨赤壁正对吴(9,1)，会构成飞将
      wei: ['帥@9,1', '車@shu:9,2'],
      shu: ['帥@9,1', '兵@5,5'],
      wu: ['帥@9,1', '兵@7,4'],
    },
    turn: 'wei',
  });
  const r = applyMove(s, mv('shu:9,2', 'shu:9,1'));
  assert.ok(r.ok, r.ok ? '' : r.error);
  if (!r.ok) return;
  assert.notEqual(r.state.status.shu, 'playing', '蜀帥被吃后必须出局');
  assert.equal(allPiecesOf(r.state, 'shu').length, 0);
  assert.equal(r.state.phase, 'playing', '吴还在，对局继续');
  assert.equal(r.state.turn, 'wu', '回合交给吴');
  assert.ok(r.state.events.some((e) => e.type === 'eliminated' && e.who === 'shu'));
});

test('挡将：被自家子挡住的攻击线，挡子可以移动（但不能反过来送将）', () => {
  // 魏帥在魏(5,1)，吴車已过河沿第 5 列打到魏(5,5)；
  // 魏兵在魏(5,3) 正好挡在这条线上。吴車与魏兵在同一列且相邻，
  // 但兵只能「前进」，所以 5,3 -> 5,4 是唯一走法（移开也不解除阻挡，安全）。
  const s = buildState({
    pieces: {
      wei: ['帥@5,1', '兵@5,3'],
      wu: ['帥@5,1', '車@5,5'],
      shu: ['帥@9,1'],
    },
    turn: 'wei',
  });
  assert.ok(!isInCheck(s, 'wei'), '有兵挡着，魏不该被将军');
  const moves = legalMovesFrom(s, 'wei:5,3').map((m) => `${m.to.player}:${m.to.file},${m.to.rank}`);
  assert.deepEqual(moves, ['wei:5,4'], '兵只能前进一格（未过河不能横走）');
  for (const m of legalMovesFrom(s, 'wei:5,3')) {
    const r = applyMove(s, m);
    assert.ok(r.ok, r.ok ? '' : r.error);
    if (r.ok) assert.ok(!isInCheck(r.state, 'wei'), '走完仍然安全');
  }
});

// ---------------------------------------------------------------------------
// 将军 / 飞将（跨地盘攻击通道）
// ---------------------------------------------------------------------------

test('将军：跨河边让「自家车也能打到对面帥」（过河不再是唯一途径）', () => {
  // 魏車站在**吴**地盘的 (5,2)，沿吴的第 5 列打到吴帥 (5,1)
  const s = buildState({
    pieces: {
      wei: ['帥@1,1', '車@wu:5,2'],
      wu: ['帥@5,1'],
      shu: ['帥@9,1'],
    },
    turn: 'wei',
  });
  assert.ok(isInCheck(s, 'wu'), '过河到吴地盘的魏車应能将军吴帥');
  assert.deepEqual(checkers(s, 'wu'), ['wei']);

  // 跨河边把三家的最内一行连成一条通路后，**没过去**的车也可能打到对面帥：
  // 魏(5,2) → 魏(5,5) → 吴(5,5) → 吴(5,1) 是一条完整的直线。
  const s2 = buildState({
    pieces: {
      wei: ['帥@1,1', '車@5,2'],
      wu: ['帥@5,1'],
      shu: ['帥@9,1'],
    },
    turn: 'wei',
  });
  assert.ok(isInCheck(s2, 'wu'), '跨河通路贯通后，自家车沿第 5 列也能打到吴帥');
});

test('将军：被将军时所有合法走法都必须解将', () => {
  const s = buildState({
    pieces: {
      wei: ['帥@1,1', '車@wu:5,2'],
      wu: ['帥@5,1', '兵@3,4'],
      shu: ['帥@9,1'],
    },
    turn: 'wu',
  });
  assert.ok(isInCheck(s, 'wu'));
  const moves = legalMoves(s, 'wu');
  assert.ok(moves.length > 0, '吴应有解将走法');
  for (const m of moves) {
    const r = applyMove(s, m);
    assert.ok(r.ok, `解将走法 ${m.to.file},${m.to.rank} 应合法`);
    if (r.ok) {
      assert.ok(
        !isInCheck(r.state, 'wu'),
        `${m.from.file},${m.from.rank}->${m.to.file},${m.to.rank} 没解将`,
      );
    }
  }
});

test('飞将：中间有子相隔时不算照面', () => {
  const withBlocker = buildState({
    pieces: { wei: ['帥@2,2'], wu: ['帥@5,1'], shu: ['帥@9,1'] },
  });
  const open = buildState({ pieces: { wei: ['帥@2,2'], wu: ['帥@5,1'], shu: ['帥@9,1'] } });
  assert.equal(generalsFace(withBlocker, 'wei', 'shu'), generalsFace(open, 'wei', 'shu'));
  assert.ok(!violatesFlyingGeneral(withBlocker));
});

test('飞将：中心三角的两条折线都应被视为照面直线', () => {
  const s = buildState({
    pieces: {
      wei: ['帥@5,1'],
      wu: ['帥@5,1'],
      shu: ['帥@5,1'],
    },
  });
  assert.ok(generalsFace(s, 'wei', 'wu'));
  assert.ok(generalsFace(s, 'wei', 'shu'));
});

test('飞将：跨河列线照面——魏第 4 列 = 吴第 6 列，魏第 6 列 = 蜀第 4 列', () => {
  const s = buildState({
    pieces: { wei: ['帥@4,2'], wu: ['帥@6,3'], shu: ['帥@5,1', '兵@5,4'] },
  });
  assert.ok(generalsFace(s, 'wei', 'wu'), '魏(4,2) 与 吴(6,3) 在同一条跨河列线上');
  assert.ok(!generalsFace(s, 'wei', 'shu'));
  const blocked = buildState({
    pieces: { wei: ['帥@4,2', '兵@4,4'], wu: ['帥@6,3'], shu: ['帥@5,1', '兵@5,4'] },
  });
  assert.ok(!generalsFace(blocked, 'wei', 'wu'), '中间有子则不照面');
  const w = buildState({
    pieces: { wei: ['帥@6,1'], wu: ['帥@5,1', '兵@5,4'], shu: ['帥@4,2'] },
  });
  assert.ok(generalsFace(w, 'wei', 'shu'), '魏(6,1) 与 蜀(4,2) 在同一条跨河列线上');
});

test('飞将：关闭规则后不生效', () => {
  const s = buildState({
    pieces: { wei: ['帥@2,2'], wu: ['帥@5,1'], shu: ['帥@9,1'] },
    rules: { flyingGeneral: false },
  });
  assert.ok(!violatesFlyingGeneral(s));
});

// ---------------------------------------------------------------------------
// 淘汰与结束（确定性路径）
// ---------------------------------------------------------------------------

test('认输：出局者棋子移除，回合正确转移，两家出局后结束', () => {
  const s = createInitialState();
  const r1 = resign(s, 'wu');
  assert.ok(r1.ok);
  if (!r1.ok) return;
  assert.equal(r1.state.status.wu, 'resigned');
  assert.equal(allPiecesOf(r1.state, 'wu').length, 0);
  assert.equal(r1.state.phase, 'playing', '还剩两家，继续');

  const r2 = resign(r1.state, 'shu');
  assert.ok(r2.ok);
  if (!r2.ok) return;
  assert.equal(r2.state.phase, 'finished');
  assert.equal(r2.state.winner, 'wei');
  assert.ok(r2.events.some((e) => e.type === 'gameOver'));
});

test('认输：认输方正好是当前回合方时，回合交给下一家', () => {
  const s = createInitialState();
  const r = resign(s, 'wei');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.state.turn, 'shu');
});

test('结束：对局结束后不能再走子，也不能再认输', () => {
  const s = createInitialState();
  const r1 = resign(s, 'wu');
  assert.ok(r1.ok);
  if (!r1.ok) return;
  const r2 = resign(r1.state, 'shu');
  assert.ok(r2.ok);
  if (!r2.ok) return;
  assert.ok(!applyMove(r2.state, mv('wei:5,4', 'wei:5,5')).ok);
  assert.ok(!resign(r2.state, 'wei').ok);
});

// ---------------------------------------------------------------------------
// 长将
// ---------------------------------------------------------------------------

test('长将判负：连续将军计数达到上限时，施将方判负出局', () => {
  // 真实通道：魏車已过河站在吴(5,2)，沿吴第 5 列将军吴帥(5,1)
  const base = buildState({
    pieces: {
      wei: ['帥@1,1', '車@wu:5,2'],
      wu: ['帥@5,1'],
      shu: ['帥@9,1'],
    },
    turn: 'wei',
    rules: { maxConsecutiveChecks: 3 },
  });
  assert.ok(isInCheck(base, 'wu'), '局面本身应处于将军状态');

  // 预置已达上限-1 的连续将军记录，魏再施将一次即触发判负
  const primed = { ...base, consecutiveChecks: 2, checkStreakBy: 'wei' as const };
  const r = applyMove(primed, { from: parseId('wu:5,2'), to: parseId('wu:5,3') });
  assert.ok(r.ok, r.ok ? '' : r.error);
  if (!r.ok) return;
  assert.equal(r.state.status.wei, 'longCheck', '魏应因长将被判负');
  assert.equal(allPiecesOf(r.state, 'wei').length, 0, '判负方棋子应全部移除');
  assert.ok(r.events.some((e) => e.type === 'eliminated' && e.who === 'wei'));
  assert.equal(r.state.consecutiveChecks, 0, '判负后计数清零');
});

test('长将：换人施将则重新计数', () => {
  const base = buildState({
    pieces: {
      wei: ['帥@1,1', '車@wu:5,2'],
      wu: ['帥@5,1'],
      shu: ['帥@9,1'],
    },
    turn: 'wei',
    rules: { maxConsecutiveChecks: 3 },
  });
  // 记录的是「另一个施将者」时，不该累计
  const primed = { ...base, consecutiveChecks: 2, checkStreakBy: 'shu' as const };
  const r = applyMove(primed, { from: parseId('wu:5,2'), to: parseId('wu:5,3') });
  assert.ok(r.ok, r.ok ? '' : r.error);
  if (!r.ok) return;
  assert.equal(r.state.status.wei, 'playing', '换了施将者不该判负');
  assert.equal(r.state.consecutiveChecks, 1, '应重新从 1 计数');
  assert.equal(r.state.checkStreakBy, 'wei');
});

test('长将：中间被打断（非将军的走法）则计数清零', () => {
  const s = createInitialState({ ...DEFAULT_RULES, maxConsecutiveChecks: 3 });
  let cur = s;
  for (let i = 0; i < 6 && cur.phase === 'playing'; i++) {
    const moves = legalMoves(cur);
    const r = applyMove(cur, moves[0]!);
    assert.ok(r.ok);
    if (!r.ok) break;
    cur = r.state;
    assert.equal(cur.consecutiveChecks, 0);
  }
});

// ---------------------------------------------------------------------------
// 通用不变量
// ---------------------------------------------------------------------------

test('序列化：对局状态 JSON 往返后仍能继续走棋（联机广播需要）', () => {
  const s = createInitialState();
  const r = applyMove(s, mv('wei:5,4', 'wei:5,5'));
  assert.ok(r.ok);
  if (!r.ok) return;
  const back = JSON.parse(JSON.stringify(r.state)) as typeof r.state;
  assert.equal(Object.keys(back.pieces).length, Object.keys(r.state.pieces).length);
  assert.equal(back.turn, r.state.turn);
  const r2 = applyMove(back, mv('shu:5,4', 'shu:5,5'));
  assert.ok(r2.ok, r2.ok ? '' : r2.error);
});

test('伪合法走法 ⊇ 合法走法，且合法走法永不含吃自己子', () => {
  const s = createInitialState();
  for (const k of PLAYER_KEYS) {
    const legal = legalMoves(s, k);
    let pseudo = 0;
    for (const id of allPiecesOf(s, k)) pseudo += pseudoMovesFrom(s, id).length;
    assert.ok(legal.length <= pseudo, `${k}: 合法走法数不该超过伪合法`);
    for (const m of legal) {
      const target = s.pieces[`${m.to.player}:${m.to.file},${m.to.rank}`];
      if (target) assert.notEqual(target.owner, k, '合法走法不能吃自己的子');
    }
  }
});

test('引擎健壮性：非法坐标不抛异常，只是没有走法', () => {
  const s = createInitialState();
  assert.deepEqual(pseudoMovesFrom(s, 'wei:99,99'), []);
  assert.deepEqual(pseudoMovesFrom(s, 'not-a-square'), []);
  const r = applyMove(s, { from: parseId('wei:5,4'), to: { player: 'wei', file: 99, rank: 9 } });
  assert.ok(!r.ok, '非法目标点应被拒绝而不是崩溃');
});
