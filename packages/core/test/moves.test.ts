/**
 * 走法生成测试：逐个棋子验证规则，包含象棋核心机制
 * （蹩马腿 / 塞象眼 / 炮隔子吃 / 九宫限制 / 相不过河 / 兵过河横走）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { POINTS, POINT_BY_ID, distance, pointVec } from '../src/board.ts';
import {
  advisorMoves,
  advisorTargets,
  cannonMoveSet,
  elephantMoves,
  elephantTargets,
  generalMoves,
  generalTargets,
  horseMoves,
  horseTargets,
  rookMoves,
  soldierMoves,
} from '../src/moves.ts';
import { DEFAULT_RULES, PLAYER_KEYS, type PlayerKey } from '../src/types.ts';
import { createInitialState, legalMovesFrom } from '../src/state.ts';

const none = () => false;
const all = () => true;
const at = (...ids: string[]) => {
  const s = new Set(ids);
  return (sq: string) => s.has(sq);
};
const sort = (xs: readonly string[]) => [...xs].sort();
/** 把点旋转到下一家的同一本地坐标（魏 → 吴 → 蜀 → 魏），用于三家对称性检查 */
const rot = (id: string) =>
  id.replace(/^(wei|wu|shu)/, (k) => ({ wei: 'wu', wu: 'shu', shu: 'wei' } as Record<string, string>)[k]!);

// ---------------------------------------------------------------------------
// 車
// ---------------------------------------------------------------------------

test('車：底线中路可横走整条底线 + 沿中路直上，并从中路渡口跨河', () => {
  const m = rookMoves('wei:5,1', none);
  assert.deepEqual(sort(m.quiet), sort([
    'wei:1,1', 'wei:2,1', 'wei:3,1', 'wei:4,1',
    'wei:6,1', 'wei:7,1', 'wei:8,1', 'wei:9,1',
    'wei:5,2', 'wei:5,3', 'wei:5,4', 'wei:5,5',
    // rank5 的 (5,5) 是两个邻家的对应点，車可沿中心三角的两条折线继续推进
    'wu:5,5', 'wu:5,4', 'wu:5,3', 'wu:5,2', 'wu:5,1',
    'shu:5,5', 'shu:5,4', 'shu:5,3', 'shu:5,2', 'shu:5,1',
  ]));
  assert.equal(m.captures.length, 0);
});

test('車：在六边形顶点（90° 直角）不能拐弯', () => {
  const m = rookMoves('wei:1,1', none);
  // 只能沿底线向右、沿第 1 列向上；不能「转进」第 2 行
  assert.ok(m.quiet.includes('wei:9,1'));
  assert.ok(m.quiet.includes('wei:1,5'));
  assert.ok(!m.quiet.includes('wei:2,2'), '顶点处不该出现拐弯落点');
  assert.equal(m.quiet.length, 8 + 4 + 5, '底线 8 + 第1列 4 + 跨河后吴第9列 5');
});

test('車/炮：行线贯穿中路——第 2~5 行在第 5 列的折角仍是同一条行线（象棋横线贯穿全盘）', () => {
  for (const player of PLAYER_KEYS) {
    for (const rank of [2, 3, 4, 5]) {
      const leftEnd = `${player}:1,${rank}`;
      const rightEnd = `${player}:9,${rank}`;
      const rookLeft = rookMoves(leftEnd, none).quiet;
      const rookRight = rookMoves(rightEnd, none).quiet;
      for (let f = 2; f <= 9; f++) {
        assert.ok(rookLeft.includes(`${player}:${f},${rank}`), `${leftEnd} 应能沿行线滑到 (${f},${rank})`);
      }
      assert.ok(rookRight.includes(leftEnd), `${rightEnd} 应能沿行线滑到 ${leftEnd}`);
      assert.ok(cannonMoveSet(leftEnd, none).quiet.includes(rightEnd), `炮 ${leftEnd} 应能沿行线走到 ${rightEnd}`);
    }
  }
  // 中路有子时照常阻挡
  const blocked = rookMoves('wei:2,3', at('wei:5,3'));
  assert.deepEqual(blocked.captures, ['wei:5,3']);
  assert.ok(!blocked.quiet.includes('wei:6,3'));
});

test('車：在最内一行折点（133°）可以沿行滑过，并可从对应点跨河', () => {
  const m = rookMoves('wei:5,5', none);
  assert.deepEqual(sort(m.quiet), sort([
    'wei:1,5', 'wei:2,5', 'wei:3,5', 'wei:4,5',
    'wei:6,5', 'wei:7,5', 'wei:8,5', 'wei:9,5',
    'wei:5,1', 'wei:5,2', 'wei:5,3', 'wei:5,4',
    // (5,5) 是三家交汇的对应点：可跨到吴、蜀的第 5 列并一路到底
    'wu:5,5', 'wu:5,4', 'wu:5,3', 'wu:5,2', 'wu:5,1',
    'shu:5,5', 'shu:5,4', 'shu:5,3', 'shu:5,2', 'shu:5,1',
  ]));
});

test('車：从角点渡口跨河后可以继续沿对岸的列滑行', () => {
  const m = rookMoves('wei:1,5', none);
  assert.ok(m.quiet.includes('wu:9,5'), '应能跨赤壁');
  assert.ok(m.quiet.includes('wu:9,1'), '跨河后应能沿吴第 9 列下行');
  assert.ok(m.quiet.includes('wei:1,1'), '应能沿自家第 1 列下行');
  // 行线到中路顶点后继续沿本行，不会拐上中央三角边（那是第 5 列的过河线）
  assert.ok(m.quiet.includes('wei:9,5'), '应能沿最内一行滑到另一端');
  assert.ok(!m.quiet.includes('shu:5,5') && !m.quiet.includes('wu:5,5'), '行线不能拐上中央三角边');
});

test('車：列线跨河接到对岸第 10 − f 列；中央三角边只属于第 5 列', () => {
  // 魏第 4 列 ⟷ 吴第 6 列（象棋：我方 4 路 = 对方 6 路）
  const m = rookMoves('wei:4,1', none).quiet;
  for (const id of ['wei:4,5', 'wu:6,5', 'wu:6,4', 'wu:6,1']) assert.ok(m.includes(id), `应能到 ${id}`);
  // 魏第 7 列 ⟷ 蜀第 3 列
  assert.ok(rookMoves('wei:7,1', none).quiet.includes('shu:3,1'));
  // 沿最内一行经过中路顶点：继续沿行，不拐上中央三角边
  const left = rookMoves('wei:4,5', none).quiet;
  assert.ok(left.includes('wei:9,5'));
  assert.ok(!left.some((id) => id.startsWith('shu:5,') || id.startsWith('wu:5,')), '行线不能拐进邻家中路');
  // 沿第 5 列直上到顶点后，中央三角两边分别接吴、蜀的第 5 列
  const up = rookMoves('wei:5,3', none).quiet;
  assert.ok(up.includes('wu:5,1') && up.includes('shu:5,1'));
});

test('車/炮：直线走法可逆、三家对称（全盘）', () => {
  const R = new Map(POINTS.map((p) => [p.id, new Set(rookMoves(p.id, none).quiet)]));
  for (const [a, set] of R) {
    for (const b of set) assert.ok(R.get(b)!.has(a), `車 ${a}→${b} 可走但反向不行`);
    assert.deepEqual(sort([...set].map(rot)), sort([...R.get(rot(a))!]), `${a} 与 ${rot(a)} 不对称`);
  }
});

test('車：遇子停止，且可以吃第一个子，不能穿过', () => {
  const occ = at('wei:5,3');
  const m = rookMoves('wei:5,1', occ);
  // 中路只到 5,2（5,3 可吃但不能穿过）；底线横向不受中路阻塞影响
  assert.deepEqual(sort(m.quiet), sort([
    'wei:1,1', 'wei:2,1', 'wei:3,1', 'wei:4,1',
    'wei:6,1', 'wei:7,1', 'wei:8,1', 'wei:9,1',
    'wei:5,2',
  ]));
  assert.deepEqual(m.captures, ['wei:5,3']);
  assert.ok(!m.quiet.includes('wei:5,4'), '不能穿过被吃的子继续走');
});

// ---------------------------------------------------------------------------
// 炮
// ---------------------------------------------------------------------------

test('炮：无炮架时只能走空格，不能吃', () => {
  const occ = at('wei:5,3');
  const m = cannonMoveSet('wei:5,1', occ);
  // 中路被炮架挡住，只能走到 5,2；底线方向仍然畅通
  assert.deepEqual(sort(m.quiet), sort([
    'wei:1,1', 'wei:2,1', 'wei:3,1', 'wei:4,1',
    'wei:6,1', 'wei:7,1', 'wei:8,1', 'wei:9,1',
    'wei:5,2',
  ]));
  assert.equal(m.captures.length, 0);
});

test('炮：隔一个子可以吃，且只能吃炮架后的第一个子', () => {
  // 中路：5,1（炮）… 5,3（炮架）… 5,5（目标）
  const occ = at('wei:5,3', 'wei:5,5');
  const m = cannonMoveSet('wei:5,1', occ);
  assert.deepEqual(m.captures, ['wei:5,5']);
  assert.ok(!m.quiet.includes('wei:5,3'), '炮架本身不能被吃');
  assert.ok(!m.quiet.includes('wei:5,4'), '炮架之后的空点不能走');
  // 底线方向无子，正常滑行
  assert.ok(m.quiet.includes('wei:9,1'));
});

test('炮：跨河后仍可隔子吃（渡口方向）', () => {
  const occ = at('wei:1,4'); // 炮架在自家第 1 列
  const m = cannonMoveSet('wei:1,5', occ);
  // 渡口方向：we 1,5 -> wu 9,5 无阻挡，可吃/走
  assert.ok(m.quiet.includes('wu:9,5'));
  assert.ok(!m.captures.includes('wu:9,5'), '没有隔子时不能吃');
});

// ---------------------------------------------------------------------------
// 馬
// ---------------------------------------------------------------------------

test('馬：标准「日」字（纵二横一、横二纵一）', () => {
  const t = horseTargets('wei:2,1');
  // 底线马的纵二横一，以及横二纵一，落点可能相同但马腿不同
  assert.deepEqual(sort([...new Set(t.map(([, l]) => l))]), ['wei:1,3', 'wei:3,3', 'wei:4,2']);
  assert.deepEqual(sort([...new Set(t.map(([lg]) => lg))]), ['wei:2,2', 'wei:3,1']);
  // 中路马：两种方向各有前后两路 → 8 个落点
  assert.deepEqual(
    sort([...new Set(horseTargets('wei:5,3').map(([, l]) => l))]),
    ['wei:3,2', 'wei:3,4', 'wei:4,1', 'wei:4,5', 'wei:6,1', 'wei:6,5', 'wei:7,2', 'wei:7,4'],
  );
  // 角上马：纵二横一、横二纵一各有一条路
  assert.deepEqual(sort([...new Set(horseTargets('wei:1,1').map(([, l]) => l))]), ['wei:2,3', 'wei:3,2']);
  // 全盘不能有「一个落点都没有」的点（否则馬会被困死）
  let dead = 0;
  for (const k of PLAYER_KEYS) {
    for (let f = 1; f <= 9; f++) {
      for (let r = 1; r <= 5; r++) {
        if (horseTargets(`${k}:${f},${r}`).length === 0) dead += 1;
      }
    }
  }
  assert.equal(dead, 0, `有 ${dead} 个点馬无路可走`);
});

test('馬：跨河按象棋处理——过河是纵向一步，马腿在长边第一格', () => {
  const has = (from: string, leg: string, landing: string) =>
    horseTargets(from).some(([l, d]) => l === leg && d === landing);
  // 纵二横一：魏(2,4) → 马腿 魏(2,5) → 吴(9,5) / 吴(7,5)（即象棋 (2,4)→(1,6)/(3,6)）
  assert.ok(has('wei:2,4', 'wei:2,5', 'wu:9,5'));
  assert.ok(has('wei:2,4', 'wei:2,5', 'wu:7,5'));
  const blocked = horseMoves('wei:2,4', at('wei:2,5'));
  assert.ok(!blocked.quiet.includes('wu:9,5') && !blocked.quiet.includes('wu:7,5'), '马腿有子则不能跨河');
  // 中路：魏(5,4) 经顶点 魏(5,5) 分别跳到 吴(6,5) 与 蜀(4,5)
  assert.ok(has('wei:5,4', 'wei:5,5', 'wu:6,5'));
  assert.ok(has('wei:5,4', 'wei:5,5', 'shu:4,5'));
  // 渡口上的馬：纵二横一的马腿是对岸的点（纵向第一格）
  assert.ok(has('wei:1,5', 'wu:9,5', 'wu:8,4'));
  assert.ok(!has('wei:3,5', 'wei:2,5', 'wu:8,4'), '纵二横一的马腿不能是本家横向的点');
  assert.ok(has('wei:3,5', 'wu:7,5', 'wu:8,4'));
  // 横二纵一跨河：魏(3,5) → 马腿 魏(2,5) → 吴(9,5)
  assert.ok(has('wei:3,5', 'wei:2,5', 'wu:9,5'));
});

test('馬：中央三角顶点处不拼假日字，全盘走法可逆、三家对称', () => {
  // 魏(4,5)→蜀(4,5) 的两条半路分属赤壁与祁山，围不成 2×1 格块
  assert.ok(!horseTargets('wei:4,5').some(([, l]) => l === 'shu:4,5'));
  assert.ok(!horseTargets('wei:5,5').some(([, l]) => l === 'wu:4,4'));
  const H = new Map(POINTS.map((p) => [p.id, new Set(horseTargets(p.id).map(([, l]) => l))]));
  for (const [a, set] of H) {
    assert.ok(set.size <= 8, `${a} 的馬有 ${set.size} 个落点（象棋最多 8 个）`);
    for (const b of set) assert.ok(H.get(b)!.has(a), `馬 ${a}→${b} 可走但反向不行`);
    assert.deepEqual(sort([...set].map(rot)), sort([...H.get(rot(a))!]), `${a} 与 ${rot(a)} 不对称`);
  }
});

test('馬：四条腿独立蹩腿（全盘无失效）', () => {
  const t = horseTargets('wei:5,3');
  const legs = [...new Set(t.map(([lg]) => lg))].sort();
  assert.equal(legs.length, 4, '中路马应有四条独立的腿');
  for (const leg of legs) {
    const owned = t.filter(([lg]) => lg === leg).map(([, l]) => l);
    const blocked = horseMoves('wei:5,3', at(leg)).quiet;
    for (const land of owned) {
      assert.ok(!blocked.includes(land), `挡住腿 ${leg} 后不该还能到 ${land}`);
    }
  }
  // 全盘：每条腿都必须真的能憋住
  let bad = 0;
  for (const p of POINTS) {
    const legsByLanding = new Map<string, string[]>();
    for (const [leg, land] of horseTargets(p.id)) {
      const legs = legsByLanding.get(land) ?? [];
      legs.push(leg);
      legsByLanding.set(land, legs);
    }
    for (const [land, legs] of legsByLanding) {
      if (horseMoves(p.id, at(...legs)).quiet.includes(land)) bad += 1;
    }
  }
  assert.equal(bad, 0, `有 ${bad} 处马腿判定失效`);
});

test('馬：蹩马腿', () => {
  for (const [leg, landing] of horseTargets('wei:2,1')) {
    const blocked = horseMoves('wei:2,1', at(leg));
    assert.ok(!blocked.quiet.includes(landing), `直步 ${leg} 有子时不能到 ${landing}`);
    assert.ok(!blocked.captures.includes(landing));
    // 不蹩腿时则可以
    const free = horseMoves('wei:2,1', none);
    assert.ok(free.quiet.includes(landing), `无阻挡时应能到 ${landing}`);
  }
});

test('馬：目标点有子则为吃子', () => {
  const t = horseTargets('wei:2,1');
  const [, landing] = t[0]!;
  const m = horseMoves('wei:2,1', at(landing));
  assert.ok(m.captures.includes(landing));
});

test('馬：三家对称，且每个点都有落点（不会被完全困死）', () => {
  for (const k of PLAYER_KEYS) {
    for (const f of [1, 3, 5, 7, 9]) {
      const targets = horseTargets(`${k}:${f},2`);
      assert.ok(targets.length > 0, `${k}(${f},2) 的马无路可走`);
    }
  }
  // 旋转同构：三家相同 (file,rank) 的落点数量一致
  for (const f of [1, 5, 9]) {
    for (const r of [1, 2, 3, 4, 5]) {
      const counts = PLAYER_KEYS.map((k) => horseTargets(`${k}:${f},${r}`).length);
      assert.equal(new Set(counts).size, 1, `(${f},${r}) 三家马落点数应一致：${counts}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 相 / 象
// ---------------------------------------------------------------------------

test('相：标准「田」字（斜走两格），象眼是对角中点', () => {
  const t = elephantTargets('wei', 'wei:3,1');
  // 底线相：向左前、右前各斜走两格
  assert.deepEqual(
    t.map(([e, l]) => `${e}>${l}`).sort(),
    ['wei:2,2>wei:1,3', 'wei:4,2>wei:5,3'],
  );
  // 中层相：四个斜向 → 4 个落点，象眼各不相同
  assert.deepEqual(
    elephantTargets('wei', 'wei:3,3').map(([e, l]) => `${e}>${l}`).sort(),
    ['wei:2,2>wei:1,1', 'wei:2,4>wei:1,5', 'wei:4,2>wei:5,1', 'wei:4,4>wei:5,5'],
  );
  // 角上相：只有 1 个落点
  assert.deepEqual(
    elephantTargets('wei', 'wei:1,1').map(([e, l]) => `${e}>${l}`),
    ['wei:2,2>wei:3,3'],
  );
  // 每个落点都必须在自家地盘内（相不过河）
  for (const [, l] of elephantTargets('wei', 'wei:5,3')) {
    assert.equal(POINT_BY_ID.get(l)!.player, 'wei');
  }
  // 全盘不能有死角
  let dead = 0;
  for (const k of PLAYER_KEYS) {
    for (let f = 1; f <= 9; f++) {
      for (let r = 1; r <= 5; r++) {
        if (elephantTargets(k, `${k}:${f},${r}`).length === 0) dead += 1;
      }
    }
  }
  assert.equal(dead, 0, `有 ${dead} 个点相无路可走`);
});

test('相：象眼 = 对角中点，被占则该方向不能走（全盘无失效）', () => {
  const t = elephantTargets('wei', 'wei:3,1');
  assert.ok(t.length > 0);
  for (const [eye, land] of t) {
    const blocked = elephantMoves('wei', 'wei:3,1', at(eye));
    assert.ok(!blocked.quiet.includes(land), `象眼 ${eye} 有子时不能到 ${land}`);
    assert.ok(!blocked.captures.includes(land));
  }
  // 象眼为空时可以走
  const free = elephantMoves('wei', 'wei:3,1', none);
  for (const [, land] of t) assert.ok(free.quiet.includes(land));
  // 全盘：每个象眼都必须真的能塞住
  let bad = 0;
  for (const k of PLAYER_KEYS) {
    for (const p of POINTS) {
      if (p.player !== k) continue;
      for (const [eye, land] of elephantTargets(k, p.id)) {
        if (elephantMoves(k, p.id, at(eye)).quiet.includes(land)) bad += 1;
      }
    }
  }
  assert.equal(bad, 0, `有 ${bad} 处象眼判定失效`);
});

test('相：塞象眼', () => {
  for (const [eye, landing] of elephantTargets('wei', 'wei:3,1')) {
    const m = elephantMoves('wei', 'wei:3,1', at(eye));
    assert.ok(!m.quiet.includes(landing), `象眼 ${eye} 有子时不能到 ${landing}`);
    assert.ok(!m.captures.includes(landing));
  }
});

test('相：不过河——所有落点都必须在自家地盘内', () => {
  for (const k of PLAYER_KEYS) {
    for (const p of POINTS) {
      if (p.player !== k) continue;
      for (const [, l] of elephantTargets(k, p.id)) {
        assert.equal(POINT_BY_ID.get(l)!.player, k, `${k} 相从 ${p.id} 到 ${l} 过河了`);
      }
    }
  }
});

test('相：纯防守子——困在自家地盘，三家完全对称', () => {
  const reach = (k: PlayerKey, f: number) => {
    const start = `${k}:${f},1`;
    const seen = new Set([start]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      for (const [, l] of elephantTargets(k, queue[head]!)) {
        if (!seen.has(l)) {
          seen.add(l);
          queue.push(l);
        }
      }
    }
    return [...seen].sort();
  };
  const wei = reach('wei', 3);
  // 相不过河；「田」字是 (纵2, 横2)，所以列号每次 ±2，只在同奇偶列之间移动
  assert.equal(wei.length, 7, `相的可达点应为自家 7 个点，实际 ${wei.length}`);
  for (const id of wei) {
    assert.equal(POINT_BY_ID.get(id)!.player, 'wei', `${id} 不该跨河`);
    assert.equal(POINT_BY_ID.get(id)!.file % 2, 1, `${id} 的列号应为奇数（田字跳两列）`);
  }
  // 三家同构
  assert.deepEqual(reach('wu', 3).map((s) => s.replace('wu', 'wei')), wei);
  assert.deepEqual(reach('shu', 3).map((s) => s.replace('shu', 'wei')), wei);
});

// ---------------------------------------------------------------------------
// 仕 / 帥
// ---------------------------------------------------------------------------

test('仕：只能在九宫内斜走，5 个九宫点与象棋一致', () => {
  const all9 = new Set(PLAYER_KEYS.map((k) => `${k}:5,2`));
  void all9;
  const seen = new Set(['wei:4,1']);
  const queue = ['wei:4,1'];
  for (let head = 0; head < queue.length; head++) {
    for (const l of advisorTargets(queue[head]!)) {
      if (!seen.has(l)) {
        seen.add(l);
        queue.push(l);
      }
    }
  }
  assert.deepEqual(sort([...seen]), sort([
    'wei:4,1', 'wei:6,1', 'wei:5,2', 'wei:4,3', 'wei:6,3',
  ]));
  // 仕不能出九宫
  for (const from of seen) {
    for (const l of advisorTargets(from)) {
      assert.ok(POINT_BY_ID.get(l)!.inPalace, `${from} -> ${l} 出九宫了`);
    }
  }
});

test('仕：九宫中心 (5,2) 可到 4 个角；只能沿九宫斜线走', () => {
  assert.deepEqual(sort(advisorTargets('wei:5,2')), sort([
    'wei:4,1', 'wei:6,1', 'wei:4,3', 'wei:6,3',
  ]));
  assert.deepEqual(advisorTargets('wei:4,1'), ['wei:5,2']);
  // 不在斜线上的九宫点之间没有斜线相连
  assert.deepEqual(advisorTargets('wei:4,2'), []);
  assert.deepEqual(advisorTargets('wei:5,1'), []);
});

test('帥：九宫内直走一格，共 9 个点，不出九宫', () => {
  const seen = new Set(['wei:5,1']);
  const queue = ['wei:5,1'];
  for (let head = 0; head < queue.length; head++) {
    for (const l of generalTargets(queue[head]!)) {
      if (!seen.has(l)) {
        seen.add(l);
        queue.push(l);
      }
    }
  }
  assert.equal(seen.size, 9, '帅可达九宫全部 9 点');
  for (const from of seen) {
    for (const l of generalTargets(from)) {
      assert.ok(POINT_BY_ID.get(l)!.inPalace, `${from} -> ${l} 出九宫了`);
    }
  }
});

test('帥：九宫中心可到 4 个直邻', () => {
  assert.deepEqual(sort(generalTargets('wei:4,1')), sort(['wei:5,1', 'wei:4,2']));
});

test('仕/帥：目标为敌子时可吃', () => {
  const m = generalMoves('wei:5,1', at('wei:5,2'));
  assert.deepEqual(m.captures, ['wei:5,2']);
  assert.equal(m.quiet.length, 2, '底线左右两点');
});

// ---------------------------------------------------------------------------
// 兵 / 卒
// ---------------------------------------------------------------------------

test('兵：自家地盘只能沿列直走（1 个方向）', () => {
  const m = soldierMoves('wei', 'wei:5,2', none);
  assert.deepEqual(m.quiet, ['wei:5,3']);
  assert.equal(m.captures.length, 0);
});

test('兵：到自家最内一行后也不能横走（未过河），只能过河', () => {
  const m = soldierMoves('wei', 'wei:5,5', none);
  // 标准象棋规则：兵未过河不能横走。
  // 自家最内一行是「河界」，从这里只能踏进相邻地盘（过河）。
  assert.ok(!m.quiet.includes('wei:4,5'), '未过河不能沿自家环横走');
  assert.ok(!m.quiet.includes('wei:6,5'), '未过河不能沿自家环横走');
  assert.deepEqual(sort(m.quiet), sort(['wu:5,5', 'shu:5,5']), '应能过河到两家');
});

test('兵：自家地盘内不能横走（三家对称）', () => {
  for (const k of PLAYER_KEYS) {
    for (let f = 1; f <= 9; f++) {
      for (let r = 1; r <= 5; r++) {
        const m = soldierMoves(k, `${k}:${f},${r}`, none);
        for (const q of m.quiet) {
          const to = POINT_BY_ID.get(q)!;
          if (to.player !== k) continue; // 过河的不算
          assert.ok(
            !(to.rank === r && to.file !== f),
            `${k}:${f},${r} 不该能横走到 ${q}（未过河）`,
          );
        }
      }
    }
  }
});

test('兵：可以过河，且不能退回自家纵深', () => {
  const m = soldierMoves('wei', 'wei:1,5', none);
  // (1,5) 是角点渡口，只与 吴(9,5) 相连
  assert.deepEqual(sort(m.quiet), sort(['wu:9,5']));
  assert.ok(!m.quiet.includes('wei:1,4'), '不能退回自家纵深');
});

test('兵：过河后（在敌家地盘）可横走 + 继续深入', () => {
  const m = soldierMoves('wei', 'wu:5,4', none);
  // 敌家地盘内：可继续深入（rank-1）也可横走
  assert.ok(m.quiet.includes('wu:4,4'), '过河兵可横走');
  assert.ok(m.quiet.includes('wu:6,4'));
  assert.ok(m.quiet.includes('wu:5,3'), '可直接向敌家老窝推进（沿列 rank-1）');
});

test('兵：任何位置都不会「无路可走」（自家地盘内）', () => {
  for (const k of PLAYER_KEYS) {
    for (const p of POINTS) {
      if (p.player !== k) continue;
      const m = soldierMoves(k, p.id, none);
      assert.ok(
        m.quiet.length + m.captures.length > 0,
        `${k} 自家 ${p.id} 的兵无路可走`,
      );
    }
  }
});

test('兵：三家规则对称（旋转不变）', () => {
  // 各家从 (5,1) 出发的走法形状应完全同构
  for (const k of PLAYER_KEYS) {
    const m = soldierMoves(k, `${k}:5,4`, none);
    assert.deepEqual(m.quiet, [`${k}:5,5`], `${k} (5,4) 应只有前进一个方向`);
  }
});

// ---------------------------------------------------------------------------
// 通用不变量
// ---------------------------------------------------------------------------

test('任何棋子的走法都必须是图上的一步一步可达（不出现跳跃）', () => {
  const occ = none;
  const emptyBoard: Record<string, (from: string) => { quiet: readonly string[]; captures: readonly string[] }> = {
    rook: (from) => rookMoves(from, occ),
    cannon: (from) => cannonMoveSet(from, occ),
    horse: (from) => horseMoves(from, occ),
    elephant: (from) => elephantMoves('wei', from, occ),
    advisor: (from) => advisorMoves(from, occ),
    general: (from) => generalMoves(from, occ),
    soldier: (from) => soldierMoves('wei', from, occ),
  };
  for (const [kind, gen] of Object.entries(emptyBoard)) {
    for (const p of POINTS) {
      if (p.player !== 'wei') continue;
      const m = gen(p.id);
      for (const t of [...m.quiet, ...m.captures]) {
        assert.ok(POINT_BY_ID.has(t), `${kind} 从 ${p.id} 到不存在的点 ${t}`);
        assert.notEqual(t, p.id, `${kind} 不该原地不动`);
      }
    }
  }
  void all;
  void pointVec;
  void DEFAULT_RULES;
  void (0 as unknown as PlayerKey);
});
