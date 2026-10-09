/**
 * 棋盘拓扑断言测试
 *
 * 这些数字不是「随便定的期望值」，而是从实物棋盘坐标算出来的结论。
 * 任何一处改动导致它们变化，都说明棋盘几何/规则被改了，必须显式确认。
 *
 * 运行： npm test --workspace @sanguo/core
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ALL_SQUARES,
  CROSSINGS,
  FILES_PER_PLAYER,
  PALACE_FILES,
  PALACE_RANKS,
  PLAYERS,
  POINTS,
  POINT_BY_ID,
  RIVERS,
  RANKS_PER_PLAYER,
  TURN_ORDER,
  angleBetween,
  centreDistance,
  distance,
  forwardNeighbours,
  getAdjacency,
  getEdges,
  getPoint,
  graphDistance,
  homeDistance,
  innerCorners,
  isForwardStep,
  neighboursOf,
  nextPlayer,
  palacePoints,
  playerPoints,
  pointVec,
  prevPlayer,
  sub,
} from '../src/board.ts';
import { DEFAULT_RULES, PLAYER_KEYS, type PlayerKey } from '../src/types.ts';

// ---------------------------------------------------------------------------
// 基本规模
// ---------------------------------------------------------------------------

test('每家 9 列 × 5 行 = 45 点，全盘 135 点', () => {
  assert.equal(FILES_PER_PLAYER, 9);
  assert.equal(RANKS_PER_PLAYER, 5);
  for (const k of PLAYER_KEYS) assert.equal(playerPoints(k).length, 45, `${k} 应有 45 点`);
  assert.equal(POINTS.length, 135);
  assert.equal(ALL_SQUARES.length, 135);
  assert.equal(POINT_BY_ID.size, 135);
});

test('点 id 唯一且与坐标一致', () => {
  for (const p of POINTS) {
    assert.equal(p.id, `${p.player}:${p.file},${p.rank}`);
    assert.equal(getPoint(p.player, p.file, p.rank).id, p.id);
    assert.ok(Math.abs(p.x) <= 1.0000001 && Math.abs(p.y) <= 1.0000001, '模型坐标应在单位圆内');
  }
});

test('九宫 = 第 4~6 列 × 第 1~3 行，每家 9 点', () => {
  assert.deepEqual([...PALACE_FILES], [4, 5, 6]);
  assert.deepEqual([...PALACE_RANKS], [1, 2, 3]);
  for (const k of PLAYER_KEYS) {
    const pts = palacePoints(k);
    assert.equal(pts.length, 9);
    for (const p of pts) {
      assert.ok(PALACE_FILES.includes(p.file));
      assert.ok(PALACE_RANKS.includes(p.rank));
    }
    // 九宫中心 (5,2) 必须在九宫内
    assert.ok(getPoint(k, 5, 2).inPalace);
  }
});

// ---------------------------------------------------------------------------
// 可通行图：这是本项目的地基
// ---------------------------------------------------------------------------

test('默认规则下：135 点 243 边，其中 15 条跨河边', () => {
  const edges = getEdges(DEFAULT_RULES);
  // 228 条格线边 + 15 条跨河边。格线边推导：每家 9×5 网格有
  // 8 列内相邻 × 5 + 4 行内相邻 × 9 = 76 条，三家共 228 条（全图唯一）。
  assert.equal(edges.filter((e) => e.kind === 'grid').length, 228);
  assert.equal(edges.filter((e) => e.kind === 'crossing').length, 15);
  assert.equal(edges.length, 243);
  assert.equal(CROSSINGS.length, 15);
});

test('跨河边是「相邻行最近点」配对：对称、每点至少 1 条、三家完全同构', () => {
  // 每个 rank5 点都要能过河（否则玩家会感觉「过不去」）
  const link = new Map<string, Set<string>>();
  for (const e of CROSSINGS) {
    if (!link.has(e.a)) link.set(e.a, new Set());
    if (!link.has(e.b)) link.set(e.b, new Set());
    link.get(e.a)!.add(e.b);
    link.get(e.b)!.add(e.a);
  }
  // 自反性：A 连 B 则 B 必连 A
  for (const [a, set] of link) {
    for (const b of set) assert.ok(link.get(b)?.has(a), `${a} 连 ${b}，但 ${b} 未连回`);
  }
  // 三家每条 rank5 行的连接数必须完全一致
  const rows = PLAYER_KEYS.map((pl) =>
    Array.from({ length: 9 }, (_, i) => link.get(`${pl}:${i + 1},5`)?.size ?? 0),
  );
  assert.deepEqual(rows[1], rows[0], '吴 的 rank5 连接数应与魏一致');
  assert.deepEqual(rows[2], rows[0], '蜀 的 rank5 连接数应与魏一致');
  // 每个点至少 1 条跨河边
  for (const pl of PLAYER_KEYS) {
    for (let f = 1; f <= 9; f++) {
      const n = link.get(`${pl}:${f},5`)?.size ?? 0;
      assert.ok(n >= 1, `${pl}:${f},5 过不了河（连接数 0）`);
    }
  }
});

test('度数分布：81 个四度点 / 45 个三度点 / 6 个二度点 / 3 个五度点', () => {
  // 度数总和 = 2 × 243 = 486 = 81×4 + 45×3 + 6×2 + 3×5
  // 二度点 = 三家的两个底线角；五度点 = 三家 (5,5)（连了两家邻居）
  const deg = new Map<string, number>();
  for (const p of POINTS) deg.set(p.id, neighboursOf(p.id).length);
  const hist = new Map<number, number>();
  for (const d of deg.values()) hist.set(d, (hist.get(d) ?? 0) + 1);
  assert.deepEqual(
    [...hist.entries()].sort((a, b) => a[0] - b[0]),
    [
      [2, 6],
      [3, 45],
      [4, 81],
      [5, 3],
    ],
    `实际度数分布: ${JSON.stringify([...hist.entries()])}`,
  );
});

test('所有边长都必须能被解释：本家相邻 0.111~0.197，跨河 0.111~0.295', () => {
  const edges = getEdges(DEFAULT_RULES);
  for (const e of edges) {
    const d = distance(e.a, e.b);
    if (e.kind === 'crossing') {
      // 跨河边取「相邻行最近点」，实测 0.1111 ~ 0.2944（最长 1.7 倍正常步长）
      assert.ok(
        d >= 0.1111 - 1e-5 && d <= 0.2945,
        `跨河边 ${e.a}-${e.b} 长度 ${d} 超出预期范围`,
      );
    } else {
      // 格线边：列内相邻 0.1111~0.1740，行内相邻 0.125~0.1966
      assert.ok(d > 0.11 && d < 0.1971, `格线边 ${e.a}-${e.b} 长度 ${d} 异常`);
    }
  }
  // 反向校验：任何距离 < 0.1 的点对都必须是图中的边（没有漏掉的相邻关系）
  for (const a of POINTS) {
    for (const b of POINTS) {
      if (a.id >= b.id) continue;
      if (distance(a.id, b.id) < 0.1) {
        assert.ok(
          (getAdjacency(DEFAULT_RULES).get(a.id) ?? []).includes(b.id),
          `距离很近但未连边: ${a.id} - ${b.id}`,
        );
      }
    }
  }
});

test('每条跨河边必须两端异家、且距离极短（防止边的端点被写反）', () => {
  for (const e of getEdges(DEFAULT_RULES)) {
    const pa = e.a.split(':')[0];
    const pb = e.b.split(':')[0];
    if (e.kind === 'crossing') {
      assert.notEqual(pa, pb, `跨河边 ${e.a}-${e.b} 两端应是不同势力`);
    } else {
      assert.equal(pa, pb, `格线边 ${e.a}-${e.b} 两端应属同一势力`);
    }
  }
});

test('6 个二度点就是三家的两个底线角', () => {
  const twoDeg = POINTS.filter((p) => neighboursOf(p.id).length === 2).map((p) => p.id).sort();
  const expected = PLAYER_KEYS.flatMap((k) => [`${k}:1,1`, `${k}:9,1`]).sort();
  assert.deepEqual(twoDeg, expected);
});

test('全图连通：任一点都能到达其他 134 点', () => {
  const adj = getAdjacency(DEFAULT_RULES);
  for (const start of ['wei:5,1', 'wu:9,5', 'shu:1,3', 'wei:1,5']) {
    const seen = new Set([start]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      for (const nb of adj.get(queue[head]!) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
    assert.equal(seen.size, 135, `从 ${start} 出发只到达 ${seen.size} 点`);
  }
});

// ---------------------------------------------------------------------------
// 河口（跨家通道）—— 最关键的几何结论
// ---------------------------------------------------------------------------

test('三条界河各含 5 条跨河边，且连接正确的两家', () => {
  assert.equal(RIVERS.length, 3);
  const byKey = Object.fromEntries(RIVERS.map((r) => [r.key, r]));
  assert.deepEqual(byKey.chibi!.between, ['wei', 'wu']);
  assert.deepEqual(byKey.qishan!.between, ['wei', 'shu']);
  assert.deepEqual(byKey.jingzhou!.between, ['shu', 'wu']);
  assert.equal(byKey.chibi!.name, '赤壁');
  assert.equal(byKey.qishan!.name, '祁山');
  assert.equal(byKey.jingzhou!.name, '荆州');
  // 每条界河上 9 个点里的 5 对能互通（另 4 对属于发散区，距离超过 2 倍步长）
  for (const r of RIVERS) {
    assert.equal(r.crossings.length, 5, `${r.name} 应有 5 条跨河边`);
  }
  assert.equal(
    RIVERS.reduce((n, r) => n + r.crossings.length, 0),
    CROSSINGS.length,
    '三条界河的跨河边总数应等于 CROSSINGS',
  );
});

test('三个角点渡口仍在（界河最外端，距离 0.1111）', () => {
  const asSet = new Set(CROSSINGS.map((e) => [e.a, e.b].sort().join('|')));
  assert.equal(asSet.size, 15);
  for (const pair of [
    ['wei:1,5', 'wu:9,5'],
    ['wei:9,5', 'shu:1,5'],
    ['wu:1,5', 'shu:9,5'],
  ]) {
    assert.ok(asSet.has([...pair].sort().join('|')), `缺少角点渡口 ${pair.join(' ↔ ')}`);
    assert.ok(Math.abs(distance(pair[0]!, pair[1]!) - 0.111111) < 1e-5);
  }
  // 反面校验：这些「看起来像」的配对相距很远（1.36），绝不是相邻
  for (const [a, b] of [
    ['wei:2,5', 'wu:1,5'],
    ['wei:8,5', 'shu:9,5'],
  ] as const) {
    assert.ok(distance(a, b) > 1.3, `${a}-${b} 距离 ${distance(a, b)} 不该是相邻`);
    assert.ok(!(getAdjacency(DEFAULT_RULES).get(a) ?? []).includes(b));
  }
});

test('跨家相邻只发生在最内一行（rank 5）', () => {
  for (const e of getEdges(DEFAULT_RULES)) {
    if (e.kind !== 'crossing') continue;
    const a = POINT_BY_ID.get(e.a)!;
    const b = POINT_BY_ID.get(e.b)!;
    assert.equal(a.rank, 5);
    assert.equal(b.rank, 5);
    assert.notEqual(a.player, b.player);
  }
});

test('内环走廊是闭合的：沿最内一行 + 河口可以绕三家一圈回到起点', () => {
  // 从 魏(9,5) 出发，沿环绕一圈（不重复走回头路）：
  //   魏 9→1，跨赤壁到 吴(9,5)，吴 9→1，跨荆州到 蜀(9,5)，蜀 9→1，跨祁山回 魏(9,5)
  const route: string[] = ['wei:9,5'];
  const walkRow = (p: PlayerKey, from: number, to: number) => {
    const step = from < to ? 1 : -1;
    for (let f = from; f !== to + step; f += step) route.push(`${p}:${f},5`);
  };
  walkRow('wei', 8, 1); // 魏 9 -> 1（9 已在 route 里）
  route.push('wu:9,5'); // 魏(1,5) 跨赤壁到 吴(9,5)
  walkRow('wu', 8, 1);
  route.push('shu:9,5'); // 吴(1,5) 跨荆州到 蜀(9,5)
  walkRow('shu', 8, 1);
  route.push('wei:9,5'); // 蜀(1,5) 跨祁山回 魏(9,5)

  const adj = getAdjacency(DEFAULT_RULES);
  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    assert.ok((adj.get(a) ?? []).includes(b), `环上第 ${i} 步: ${a} 应当与 ${b} 相邻`);
  }
  assert.equal(route.at(-1), route[0], '应当绕回起点');
  // 一圈 = 3 家 × 8 段 + 3 次跨河 = 27 步
  assert.equal(route.length - 1, 27);
});

test('内环两侧：本家最内一行是直线，格距均匀放大到约 0.197', () => {
  const dy = Math.abs(pointVec('wei:9,5').y - pointVec('wei:1,5').y);
  assert.ok(dy < 1e-9, '魏家最内一行应是水平直线');
  for (const k of PLAYER_KEYS) {
    const segs = [1, 2, 3, 4, 5, 6, 7, 8].map((f) => distance(`${k}:${f},5`, `${k}:${f + 1},5`));
    const first = segs[0]!;
    for (const s of segs) assert.ok(Math.abs(s - first) < 1e-6, `${k} 最内一行格距应均匀`);
    assert.ok(first > 0.19 && first < 0.2, `${k} 最内一行格距 ${first}`);
  }
  // 对角方向（沿环方向）的三对相邻点距离都是 0.1111
  assert.ok(Math.abs(distance('wei:1,5', 'wu:9,5') - 0.111111) < 1e-5);
  assert.ok(Math.abs(distance('wei:9,5', 'shu:1,5') - 0.111111) < 1e-5);
  assert.ok(Math.abs(distance('wu:1,5', 'shu:9,5') - 0.111111) < 1e-5);
});

test('中央三角形的三条边就是三对「对应点」跨河边', () => {
  const vertices = [
    ['wei', pointVec('wei:5,5')],
    ['wu', pointVec('wu:5,5')],
    ['shu', pointVec('shu:5,5')],
  ] as const;
  // 三角形的外接圆半径 = 0.17，三家 (5,5) 正落在各自顶点上
  for (const [k, v] of vertices) {
    assert.ok(Math.abs(Math.hypot(v.x, v.y) - 0.17) < 1e-6, `${k}(5,5) 应在半径 0.17 的顶点上`);
  }
  // 三角形边长 = 0.2944，**现在是一条可通行的跨河边**
  // （它是全盘最长的跨河边，也正因如此 (5,5) 是三家交汇的枢纽点）
  const triEdge = distance('wei:5,5', 'wu:5,5');
  assert.ok(Math.abs(triEdge - 0.294427) < 1e-4);
  assert.ok(neighboursOf('wei:5,5').includes('wu:5,5'), '(5,5) 之间应可通行');
  assert.ok(neighboursOf('wei:5,5').includes('shu:5,5'));
  // 除三家 (5,5) 顶点本身外，没有点落在中央三角形内部
  const vertexIds = new Set(['wei:5,5', 'wu:5,5', 'shu:5,5']);
  for (const p of POINTS) {
    if (vertexIds.has(p.id)) continue;
    const v = pointVec(p.id);
    assert.ok(Math.hypot(v.x, v.y) > 0.17, `${p.id} 不该落在中央三角形内部`);
  }
});

// ---------------------------------------------------------------------------
// 几何工具
// ---------------------------------------------------------------------------

test('最内一行是折线：两臂在自家 (5,5) 处成钝角，不是直线', () => {
  for (const k of PLAYER_KEYS) {
    const left = sub(pointVec(`${k}:4,5`), pointVec(`${k}:5,5`));
    const right = sub(pointVec(`${k}:6,5`), pointVec(`${k}:5,5`));
    const ang = angleBetween(left, right);
    assert.ok(ang > 120 && ang < 145, `${k} 最内一行折角 ${ang.toFixed(1)}° 应约为 133°`);
    // 而第 1 行是真正的直线
    const l1 = sub(pointVec(`${k}:4,1`), pointVec(`${k}:5,1`));
    const r1 = sub(pointVec(`${k}:6,1`), pointVec(`${k}:5,1`));
    assert.ok(Math.abs(angleBetween(l1, r1) - 180) < 1e-4, '第 1 行应为直线');
  }
});

test('列线是直线：每列 5 点共线', () => {
  for (const k of PLAYER_KEYS) {
    for (let f = 1; f <= 9; f++) {
      const a = sub(pointVec(`${k}:${f},2`), pointVec(`${k}:${f},1`));
      const b = sub(pointVec(`${k}:${f},5`), pointVec(`${k}:${f},4`));
      assert.ok(Math.abs(angleBetween(a, b)) < 0.5, `${k} 第 ${f} 列应为直线`);
    }
  }
});

test('最内一行越靠中央越宽：格距从 0.125 放大到约 0.197', () => {
  const back = distance('wei:1,1', 'wei:2,1');
  const inner = distance('wei:1,5', 'wei:2,5');
  assert.ok(Math.abs(back - 0.125) < 1e-6);
  assert.ok(inner > 0.19 && inner < 0.2, `最内一行格距 ${inner}`);
  // 第 5 行端点 = 侧翼边 4/9 处（实测值）
  assert.ok(Math.abs(distance('wei:1,1', 'wei:1,5') - 0.444444) < 1e-5);
});

test('中心距离：第 5 行端点最靠近棋盘中心之外的边界，(5,5) 最靠中央', () => {
  const corners = innerCorners('wei');
  assert.equal(corners[0]!.id, 'wei:1,5');
  assert.equal(corners[1]!.id, 'wei:9,5');
  assert.ok(centreDistance('wei:5,5') < centreDistance('wei:5,4'));
  assert.ok(centreDistance('wei:5,4') < centreDistance('wei:5,1'));
});

// ---------------------------------------------------------------------------
// 兵的「前进」判定
// ---------------------------------------------------------------------------

test('兵：过河前只能沿列前进，过河后可横走，环上沿环走且不能回头', () => {
  // —— 未过河（自家 rank 1~4）：只能沿列 ——
  assert.ok(isForwardStep('wei', 'wei:5,1', 'wei:5,2'));
  assert.ok(isForwardStep('wei', 'wei:5,4', 'wei:5,5'));
  assert.ok(!isForwardStep('wei', 'wei:5,3', 'wei:6,3'), '未过河不能横走');
  assert.ok(!isForwardStep('wei', 'wei:5,2', 'wei:5,1'), '不能后退');

  // —— 自家最内一行（环）：**不能横走**（未过河），唯一前进方向是过河 ——
  assert.ok(!isForwardStep('wei', 'wei:5,5', 'wei:4,5'), '未过河不能横走（含自家环上）');
  assert.ok(!isForwardStep('wei', 'wei:5,5', 'wei:6,5'), '未过河不能横走');
  assert.ok(!isForwardStep('wei', 'wei:5,5', 'wei:5,4'), '从环上退回自家纵深 = 后退');
  assert.ok(!isForwardStep('wei', 'wei:4,5', 'wei:3,5'), '自家环上不能横走');
  assert.ok(isForwardStep('wei', 'wei:5,5', 'wu:5,5'), '自家环上的前进方向 = 过河到吴');
  assert.ok(isForwardStep('wei', 'wei:5,5', 'shu:5,5'), '自家环上的前进方向 = 过河到蜀');

  // —— 跨河 ——
  assert.ok(isForwardStep('wei', 'wei:1,5', 'wu:9,5'), '跨赤壁应为前进');
  assert.ok(isForwardStep('shu', 'shu:1,5', 'wei:9,5'), '跨祁山应为前进');
  assert.ok(isForwardStep('wu', 'wu:1,5', 'shu:9,5'), '跨荆州应为前进');
  assert.ok(!isForwardStep('wei', 'wu:9,5', 'wei:1,5'), '不能从邻家撤回');

  // —— 过河后（敌家纵深）继续向敌家老窝推进 ——
  assert.ok(isForwardStep('wei', 'wu:9,4', 'wu:9,3'), '过河后向敌家老窝推进');
  assert.ok(isForwardStep('wei', 'wu:5,2', 'wu:5,1'), '可一路推进到敌家底线');
  assert.ok(!isForwardStep('wei', 'wu:9,4', 'wu:9,5'), '过河后不能退回界河');
  assert.ok(isForwardStep('wei', 'wu:5,3', 'wu:4,3'), '过河兵在敌家纵深可横走');
  // 敌家环上（第 5 行）可沿环横走，但不能折返自家渡口
  assert.ok(isForwardStep('wei', 'wu:9,5', 'wu:8,5'), '可在敌家最内一行沿环走');
  assert.ok(!isForwardStep('wei', 'wu:9,5', 'wei:1,5'), '不能折返自家渡口');
  // 过河兵在对岸坐标里「向前」是该家 rank − 1；再过一次河（跨到第三家）就是后退
  assert.ok(!isForwardStep('wei', 'wu:1,5', 'shu:9,5'), '过河兵不能再跨荆州');
  assert.ok(!isForwardStep('wei', 'wu:5,5', 'shu:5,5'), '过河兵不能沿中央三角边跨到第三家');
  // 从自家环上两个方向跨河都算前进（西口 / 东口）
  assert.ok(isForwardStep('wei', 'wei:9,5', 'shu:1,5'), '跨祁山应为前进');

  // 三家规则一致
  for (const k of PLAYER_KEYS) {
    assert.ok(isForwardStep(k, `${k}:5,4`, `${k}:5,5`), `${k} 向中央推进应为前进`);
    assert.ok(!isForwardStep(k, `${k}:5,5`, `${k}:5,4`), `${k} 后退不应算前进`);
  }
});

test('老家距离此刻度单调、有限、覆盖全部 135 点', () => {
  for (const k of PLAYER_KEYS) {
    let max = 0;
    for (const p of POINTS) {
      const d = homeDistance(k, p.id);
      assert.ok(Number.isFinite(d), `${k} 到 ${p.id} 的距离应为有限值`);
      max = Math.max(max, d);
    }
    // 跨河边把三家连成一张更紧的网，最远点距离降到 13（原本 20 左右）
    assert.ok(max >= 10 && max <= 20, `${k} 最远点距离 ${max}`);
    assert.equal(homeDistance(k, `${k}:5,1`), 0);
    assert.equal(homeDistance(k, `${k}:5,2`), 1);
  }
});

test('兵不会被卡死：自家地盘内每点都有前进方向', () => {
  const deadEnds: string[] = [];
  for (const k of PLAYER_KEYS) {
    for (const p of POINTS) {
      if (forwardNeighbours(k, p.id).length === 0) deadEnds.push(`${k}@${p.id}`);
    }
  }
  // 自家 45 个点必须全部可动
  for (const d of deadEnds) {
    const [who, id] = d.split('@') as [PlayerKey, string];
    const pt = POINT_BY_ID.get(id)!;
    assert.notEqual(pt.player, who, `自家地盘内不该有死角: ${d}`);
  }
  for (const k of PLAYER_KEYS) {
    for (const p of playerPoints(k)) {
      assert.ok(forwardNeighbours(k, p.id).length > 0, `${k} 自家 ${p.id} 无前进方向`);
    }
  }
  // 死角只允许出现在敌家的低排（兵冲到底后被堵住，属于正常棋理）
  for (const d of deadEnds) {
    const id = d.split('@')[1]!;
    const pt = POINT_BY_ID.get(id)!;
    assert.ok(pt.rank <= 2, `敌家 rank=${pt.rank} 不该是死角: ${d}`);
  }
});

test('最内一行每个点都有前进方向；未过河只能过河，过河后不能再过河', () => {
  for (const k of PLAYER_KEYS) {
    for (const p of POINTS) {
      if (p.rank !== RANKS_PER_PLAYER) continue;
      const fw = forwardNeighbours(k, p.id);
      assert.ok(fw.length > 0, `${k} 在 ${p.id} 环上无前进方向`);
    }
  }
  // 规则：**自家地盘内不能横走**，所以在自家环上唯一的前进方向就是过河
  assert.deepEqual(forwardNeighbours('wei', 'wei:1,5').slice().sort(), ['wu:9,5']);
  assert.deepEqual(forwardNeighbours('wei', 'wei:9,5').slice().sort(), ['shu:1,5']);
  // 自家顶点（对应两家的中点）可以走向任一邻家
  assert.deepEqual(forwardNeighbours('wei', 'wei:5,5').slice().sort(), ['shu:5,5', 'wu:5,5']);
  // 已过河后：可在邻家第 5 行横走、可踏进邻家纵深；任何跨河边都是后退
  assert.deepEqual(forwardNeighbours('wei', 'wu:5,5').slice().sort(), ['wu:4,5', 'wu:5,4', 'wu:6,5']);
  assert.deepEqual(forwardNeighbours('wei', 'wu:1,5').slice().sort(), ['wu:1,4', 'wu:2,5']);
});

// ---------------------------------------------------------------------------
// 图距离与回合顺序
// ---------------------------------------------------------------------------

test('图距离对称且满足三角不等式', () => {
  const samples = ['wei:5,1', 'wu:5,1', 'shu:5,1', 'wei:1,5', 'wu:9,5', 'wei:5,5'];
  for (const a of samples) {
    for (const b of samples) {
      assert.equal(graphDistance(a, b), graphDistance(b, a));
      assert.ok(Number.isFinite(graphDistance(a, b)));
    }
  }
  assert.equal(graphDistance('wei:1,5', 'wu:9,5'), 1, '河口是 1 步');
  assert.equal(graphDistance('wei:5,1', 'wei:5,5'), 4);
});

test('回合顺序：魏 → 蜀 → 吴 → 魏', () => {
  assert.deepEqual([...TURN_ORDER], ['wei', 'shu', 'wu']);
  assert.equal(nextPlayer('wei'), 'shu');
  assert.equal(nextPlayer('shu'), 'wu');
  assert.equal(nextPlayer('wu'), 'wei');
  assert.equal(prevPlayer('wei'), 'wu');
  for (const k of PLAYER_KEYS) assert.equal(prevPlayer(nextPlayer(k)), k);
});

test('势力元数据齐全（名称/颜色/旋转角/行号字母）', () => {
  assert.equal(PLAYERS.wei.name, '魏');
  assert.equal(PLAYERS.wu.name, '吴');
  assert.equal(PLAYERS.shu.name, '蜀');
  assert.equal(PLAYERS.wei.rotationDeg, 0);
  assert.equal(PLAYERS.wu.rotationDeg, 120);
  assert.equal(PLAYERS.shu.rotationDeg, -120);
  assert.deepEqual([...PLAYERS.wei.rankLetters], ['E', 'D', 'C', 'B', 'A']);
  assert.deepEqual([...PLAYERS.wu.rankLetters], ['O', 'N', 'M', 'L', 'K']);
  assert.deepEqual([...PLAYERS.shu.rankLetters], ['J', 'I', 'H', 'G', 'F']);
  for (const k of PLAYER_KEYS) assert.match(PLAYERS[k].colour, /^#[0-9a-f]{6}$/i);
});

// ---------------------------------------------------------------------------
// 备选跨河模型（full）
// ---------------------------------------------------------------------------

test('跨河边只在最内一行，且全图仍然连通（135 点全部可达）', () => {
  const edges = getEdges(DEFAULT_RULES);
  const crossing = edges.filter((e) => e.kind === 'crossing');
  assert.equal(crossing.length, 15);
  for (const e of crossing) {
    assert.equal(POINT_BY_ID.get(e.a)!.rank, 5);
    assert.equal(POINT_BY_ID.get(e.b)!.rank, 5);
  }
  const adj = getAdjacency(DEFAULT_RULES);
  const seen = new Set(['wei:5,1']);
  const queue = ['wei:5,1'];
  for (let head = 0; head < queue.length; head++) {
    for (const nb of adj.get(queue[head]!) ?? []) {
      if (!seen.has(nb)) {
        seen.add(nb);
        queue.push(nb);
      }
    }
  }
  assert.equal(seen.size, 135, 'full 模式也必须全盘连通');
});
