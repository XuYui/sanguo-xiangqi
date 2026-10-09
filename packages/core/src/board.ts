/**
 * 三人象棋 —— 棋盘拓扑层
 *
 * 本模块把实物棋盘的几何逆向结论固化成一张「可通行图」：
 *   135 个交叉点 + 243 条边（其中 15 条是界河跨越边）
 *
 * 关键结论（由 board_data.json 的精确坐标算出，见 test/topology.test.ts 的断言）：
 *  1. 三家地盘的格线本身互不相连；跨家通道是三条界河上的 15 条对应边，最外端的 3 对是角点渡口。
 *  2. 每家第 5 行（最内一行）是折线：角点 → 自家九宫顶点 → 角点（"^" 形，共 8 段）。
 *  3. 三家第 5 行 + 3 对角点渡口构成 27 步闭合内环，额外的对应边仍使全图连通。
 *  4. 中央三角形内部没有任何线路，棋子永远进不去（它是印刷装饰腔）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  BoardPoint,
  Edge,
  PlayerInfo,
  PlayerKey,
  RiverDef,
  Square,
  RuleConfig,
} from './types.ts';
import { DEFAULT_RULES, PLAYER_KEYS } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(HERE, '..', 'data', 'board_data.json');

const FILES = 9;
const RANKS = 5;
/** 每家的中路列号（九宫中心列） */
const MID_FILE = (FILES + 1) / 2; // 5
export const PALACE_FILES: readonly number[] = [4, 5, 6];
export const PALACE_RANKS: readonly number[] = [1, 2, 3];

// ---------------------------------------------------------------------------
// 原始数据（已由 tools/verify 校验过：与生成器公式重算结果逐点一致）
// ---------------------------------------------------------------------------

interface RawPoint {
  file: number;
  rank: number;
  rank_letter: string;
  x: number;
  y: number;
  palace: boolean;
  back_rank: boolean;
  river_rank: boolean;
}

interface RawBoardData {
  meta: { files_per_player: number; ranks_per_player: number };
  hexagon: { R: number; vertices: Record<string, [number, number]> };
  centre_triangle: { circumradius: number; vertices: Record<PlayerKey, [number, number]> };
  players: Record<
    PlayerKey,
    {
      name: string;
      colour: string;
      rotation_deg: number;
      neighbours: [PlayerKey, PlayerKey];
      rank_letters: string[];
      points: RawPoint[];
    }
  >;
}

const raw = JSON.parse(readFileSync(DATA_PATH, 'utf-8')) as RawBoardData;

// ---------------------------------------------------------------------------
// 点
// ---------------------------------------------------------------------------

export function sqId(player: PlayerKey, file: number, rank: number): string {
  return `${player}:${file},${rank}`;
}

export function makeSquare(player: PlayerKey, file: number, rank: number): Square {
  return { player, file, rank };
}

export function squareId(sq: Square): string {
  return sqId(sq.player, sq.file, sq.rank);
}

export function sameSquare(a: Square, b: Square): boolean {
  return a.player === b.player && a.file === b.file && a.rank === b.rank;
}

/** 全部 135 个交叉点，按势力、列、行排序 */
export const POINTS: readonly BoardPoint[] = PLAYER_KEYS.flatMap((key) =>
  [...raw.players[key].points]
    .sort((p, q) => p.rank - q.rank || p.file - q.file)
    .map<BoardPoint>((p) => ({
      player: key,
      file: p.file,
      rank: p.rank,
      id: sqId(key, p.file, p.rank),
      x: p.x,
      y: p.y,
      inPalace: p.palace,
      onBackRank: p.back_rank,
      onRiverRank: p.river_rank,
    })),
);

export const POINT_BY_ID: ReadonlyMap<string, BoardPoint> = new Map(POINTS.map((p) => [p.id, p]));

export function getPoint(player: PlayerKey, file: number, rank: number): BoardPoint {
  const p = POINT_BY_ID.get(sqId(player, file, rank));
  if (!p) throw new Error(`不存在的交叉点: ${player} (${file},${rank})`);
  return p;
}

export function isOnBoard(player: PlayerKey, file: number, rank: number): boolean {
  return file >= 1 && file <= FILES && rank >= 1 && rank <= RANKS && PLAYER_KEYS.includes(player);
}

/** 只返回存在的点（越界返回 undefined） */
export function tryPoint(player: PlayerKey, file: number, rank: number): BoardPoint | undefined {
  return isOnBoard(player, file, rank) ? getPoint(player, file, rank) : undefined;
}

// ---------------------------------------------------------------------------
// 势力信息
// ---------------------------------------------------------------------------

function toPlayerInfo(key: PlayerKey): PlayerInfo {
  const p = raw.players[key];
  return {
    key,
    name: p.name,
    colour: p.colour,
    rotationDeg: p.rotation_deg,
    neighbours: p.neighbours,
    rankLetters: p.rank_letters,
  };
}

export const PLAYERS: Readonly<Record<PlayerKey, PlayerInfo>> = {
  wei: toPlayerInfo('wei'),
  shu: toPlayerInfo('shu'),
  wu: toPlayerInfo('wu'),
};

/** 回合顺序的下一家：魏 → 蜀 → 吴 → 魏（棋盘上为逆时针：下 → 右上 → 左上） */
export const TURN_ORDER: readonly PlayerKey[] = ['wei', 'shu', 'wu'] as const;

export function nextPlayer(p: PlayerKey): PlayerKey {
  const i = TURN_ORDER.indexOf(p);
  return TURN_ORDER[(i + 1) % TURN_ORDER.length]!;
}

export function prevPlayer(p: PlayerKey): PlayerKey {
  const i = TURN_ORDER.indexOf(p);
  return TURN_ORDER[(i + TURN_ORDER.length - 1) % TURN_ORDER.length]!;
}

export const BOARD_RADIUS = raw.hexagon.R;
export const CENTRE_TRIANGLE = raw.centre_triangle;

// ---------------------------------------------------------------------------
// 界河与河口（跨家通道）
// ---------------------------------------------------------------------------

/**
 * 跨家通道。三对角点渡口两端距离恰为 0.1111 = 六边形边长的 1/9，
 * 其余对应边的距离约为 0.111~0.294。
 *
 * 每条界河最外端各有一对角点渡口，三家第 5 行与这三对连接构成 27 步内环：
 *
 *        魏(1,5) ⟷ 吴(9,5)          赤壁（魏 | 吴，左下）
 *        魏(9,5) ⟷ 蜀(1,5)          祁山（魏 | 蜀，右下）
 *        吴(1,5) ⟷ 蜀(9,5)          荆州（蜀 | 吴，上方）
 *
 * 沿环走：魏 1→9，过祁山到 蜀 1→9，过荆州到 吴 1→9，过赤壁回 魏 1（共 27 步）。
 * 其余跨河对应边位于同一条界河的 rank 5 上；完整图的跨河边共 15 条。
 */
/**
 * 三个「角点渡口」——两家地盘相接的最外端那一个点（距离 0.111，最短）。
 * 现在只是全部对应点里的前 3 对，保留此常量用于标注界河名与调试。
 */
const GATE_PAIRS: readonly (readonly [string, string])[] = [
  ['wei:1,5', 'wu:9,5'], // 赤壁
  ['wei:9,5', 'shu:1,5'], // 祁山
  ['wu:1,5', 'shu:9,5'], // 荆州
];

/** 三家两两相邻的势力对（也是三条界河） */
export const ADJACENT_PAIRS: readonly (readonly [PlayerKey, PlayerKey])[] = [
  ['wei', 'shu'],
  ['wei', 'wu'],
  ['shu', 'wu'],
];

function canonicalKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** 一条跨河边的两个端点分别属于哪两家 */
export function crossingSides(e: Edge): readonly [PlayerKey, PlayerKey] {
  const pa = e.a.split(':')[0] as PlayerKey;
  const pb = e.b.split(':')[0] as PlayerKey;
  return [pa, pb];
}

/**
 * 相邻两家最内一行（rank 5）的**对应点**跨河连接。
 *
 * 做法：对每个 rank5 点，在**每条相邻行**上取最近的那个点，距离不超过
 * 2 倍正常相邻步长（0.174 × 2 ≈ 0.348，取 0.32 留余量）才连。
 *
 * 为什么不能用「列号镜像 f ↔ 10−f」直接配对（走过的弯路）：
 *   镜像只对**一家**邻居成立。若同时套给两家，会连出 `魏:1,5↔吴:9,5`
 *   这种 1.5556 长的边（是正常步长的 9 倍），还会让部分点的度数虚高到 5。
 *   根因是扇形棋盘上「每个点只与一家邻居真正贴边」，与另一家是发散的。
 *
 * 实测结果（对称性已验证）：
 *   - 15 条跨河边，距离 0.111 ~ 0.294（最长仅 1.7 倍正常步长）
 *   - 每个 rank5 点至少 1 条跨河边（不存在过不了河的点）
 *   - 三家完全对称：每条行都是 `1:1 2:1 3:1 4:1 5:2 6:1 7:1 8:1 9:1`
 *   - 自反性成立：A 连 B 则 B 必连 A
 *
 * 于是「过河」变成一件自然的事：走到自家最内一行即可踏入相邻地盘。
 */
function buildFullCrossings(): Edge[] {
  const out: Edge[] = [];
  const seen = new Set<string>();
  const MAX_CROSS = 0.32; // ≈ 2 倍正常相邻步长

  for (const player of PLAYER_KEYS) {
    const others = ADJACENT_PAIRS.filter(([a, b]) => a === player || b === player).map(
      ([a, b]) => (a === player ? b : a),
    );
    for (let f = 1; f <= FILES; f++) {
      const id = sqId(player, f, RANKS);
      for (const other of others) {
        let best: { id: string; d: number } | null = null;
        for (let g = 1; g <= FILES; g++) {
          const cand = sqId(other, g, RANKS);
          const d = distance(id, cand);
          if (!best || d < best.d) best = { id: cand, d };
        }
        if (!best || best.d > MAX_CROSS) continue;
        const key = canonicalKey(id, best.id);
        if (seen.has(key)) continue;
        seen.add(key);
        // 边的方向影响「界河归属」，按玩家定义顺序排
        const [pa, pb] = crossingSides({ a: id, b: best.id } as Edge);
        const forward = PLAYER_KEYS.indexOf(pa) <= PLAYER_KEYS.indexOf(pb);
        out.push(
          forward
            ? ({ a: id, b: best.id, kind: 'crossing' } as Edge)
            : ({ a: best.id, b: id, kind: 'crossing' } as Edge),
        );
      }
    }
  }
  return out;
}

/**
 * 全部跨河边：三家两两之间各 5 对镜像对应点，共 15 条。
 * 定义在此是因为 `buildFullCrossings` 是函数声明（可提升），无须担心顺序。
 */
export const CROSSINGS: readonly Edge[] = buildFullCrossings();

export const RIVERS: readonly RiverDef[] = (
  [
    ['chibi', '赤壁', 'wei', 'wu'],
    ['qishan', '祁山', 'wei', 'shu'],
    ['jingzhou', '荆州', 'shu', 'wu'],
  ] as const
).map(([key, name, a, b]) => ({
  key,
  name,
  between: [a, b] as const,
  crossings: CROSSINGS.filter((e) => {
    const [pa, pb] = crossingSides(e);
    return (pa === a && pb === b) || (pa === b && pb === a);
  }).map((e) => [e.a, e.b] as const),
}));
// ---------------------------------------------------------------------------
// 可通行图
// ---------------------------------------------------------------------------

function buildEdges(config: RuleConfig): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const push = (a: string, b: string, kind: Edge['kind']) => {
    const key = canonicalKey(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ a, b, kind });
  };

  for (const key of PLAYER_KEYS) {
    for (let f = 1; f <= FILES; f++) {
      for (let r = 1; r <= RANKS; r++) {
        if (f < FILES) push(sqId(key, f, r), sqId(key, f + 1, r), 'grid');
        if (r < RANKS) push(sqId(key, f, r), sqId(key, f, r + 1), 'grid');
      }
    }
  }

  // 跨河边：全部 15 对对应点（三家两两各 5 对）
  for (const e of CROSSINGS) push(e.a, e.b, 'crossing');

  return edges;
}

const EDGE_CACHE = new Map<string, readonly Edge[]>();
const ADJ_CACHE = new Map<string, ReadonlyMap<string, readonly string[]>>();

function cacheKey(config: RuleConfig): string {
  // 目前可通行图不再随规则变化（跨河已是固定 15 对），保留签名以便将来扩展
  return `${config.flyingGeneral ? 'fly' : 'nofly'}`;
}

/** 全部边（默认规则） */
export const EDGES: readonly Edge[] = buildEdges(DEFAULT_RULES);

export function getEdges(config: RuleConfig = DEFAULT_RULES): readonly Edge[] {
  const k = cacheKey(config);
  let e = EDGE_CACHE.get(k);
  if (!e) {
    e = buildEdges(config);
    EDGE_CACHE.set(k, e);
  }
  return e;
}

/** 邻接表：点 id -> 相邻点 id 列表 */
export function getAdjacency(config: RuleConfig = DEFAULT_RULES): ReadonlyMap<string, readonly string[]> {
  const k = cacheKey(config);
  let adj = ADJ_CACHE.get(k);
  if (!adj) {
    const m = new Map<string, string[]>();
    for (const p of POINTS) m.set(p.id, []);
    for (const e of getEdges(config)) {
      m.get(e.a)!.push(e.b);
      m.get(e.b)!.push(e.a);
    }
    adj = m;
    ADJ_CACHE.set(k, adj);
  }
  return adj;
}

export function neighboursOf(id: string, config: RuleConfig = DEFAULT_RULES): readonly string[] {
  return getAdjacency(config).get(id) ?? [];
}

export function edgeKind(a: string, b: string, config: RuleConfig = DEFAULT_RULES): Edge['kind'] | null {
  for (const e of getEdges(config)) {
    if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return e.kind;
  }
  return null;
}

/** 是否跨家相邻（界河两口） */
export function isCrossing(a: string, b: string): boolean {
  return edgeKind(a, b) === 'crossing';
}

// ---------------------------------------------------------------------------
// 几何工具：行/列方向
// ---------------------------------------------------------------------------

export interface Vec {
  readonly x: number;
  readonly y: number;
}

export function sub(a: Vec, b: Vec): Vec {
  return { x: a.x - b.x, y: a.y - b.y };
}
export function dot(a: Vec, b: Vec): number {
  return a.x * b.x + a.y * b.y;
}
export function len(a: Vec): number {
  return Math.hypot(a.x, a.y);
}
export function angleBetween(a: Vec, b: Vec): number {
  const la = len(a);
  const lb = len(b);
  if (la === 0 || lb === 0) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb)))) * 180) / Math.PI;
}

export function pointVec(id: string): Vec {
  const p = POINT_BY_ID.get(id);
  if (!p) throw new Error(`不存在的点: ${id}`);
  return { x: p.x, y: p.y };
}

/**
 * 一家地盘的「前进单位向量」= 从该家第 1 行指向第 5 行的方向。
 * 用于兵的推进方向、以及判断某点是否更靠近中央。
 */
export function forwardUnit(player: PlayerKey): Vec {
  const a = getPoint(player, 5, 1);
  const b = getPoint(player, 5, RANKS);
  const v = sub({ x: b.x, y: b.y }, { x: a.x, y: a.y });
  const l = len(v);
  return { x: v.x / l, y: v.y / l };
}

/** 棋盘中心到某点的距离（模型单位）：越小 = 越靠中央 */
export function centreDistance(id: string): number {
  const p = pointVec(id);
  return Math.hypot(p.x, p.y);
}

/** 距离棋盘中心的「内向」分量（越大 = 越往中央推进） */
export function inwardness(id: string): number {
  return -centreDistance(id);
}

/** 两点间的直线距离（模型单位） */
export function distance(idA: string, idB: string): number {
  const a = pointVec(idA);
  const b = pointVec(idB);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const FORWARD_DIST_CACHE = new Map<string, ReadonlyMap<string, number>>();

/**
 * 从某家九宫中心 (5,1) 沿可通行图做 BFS，得到「离自家老家的步数」表。
 * 仅作信息展示与调试（规则审阅图 07）；兵的走法不依赖它，
 * 而是按象棋的「过河前只进、过河后可横、永不后退」直接判定（见 forwardNeighbours）。
 */
function forwardDistanceMap(player: PlayerKey, config: RuleConfig): ReadonlyMap<string, number> {
  const key = `${player}|${cacheKey(config)}`;
  let cached = FORWARD_DIST_CACHE.get(key);
  if (cached) return cached;

  const adj = getAdjacency(config);
  const start = sqId(player, 5, 1); // 自家九宫中心（帅的初始位置）
  const dist = new Map<string, number>([[start, 0]]);
  const queue: string[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    const d = dist.get(cur)!;
    for (const nb of adj.get(cur) ?? []) {
      if (dist.has(nb)) continue;
      dist.set(nb, d + 1);
      queue.push(nb);
    }
  }
  cached = dist;
  FORWARD_DIST_CACHE.set(key, cached);
  return cached;
}

/** 某点离该家老家的步数（图距离；越远 = 越深入敌境） */
export function homeDistance(
  player: PlayerKey,
  id: string,
  config: RuleConfig = DEFAULT_RULES,
): number {
  return forwardDistanceMap(player, config).get(id) ?? Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------------------
// 方向化走步：把象棋「横 / 纵」与「过河」映射到这张棋盘
// ---------------------------------------------------------------------------

/**
 * 以**出发地盘**的本地坐标表示的四个正交方向：
 *   U = rank + 1（朝界河 / 前）  D = rank − 1（朝底线 / 后）
 *   L = file − 1                 R = file + 1
 *
 * 象棋的核心对应关系（本棋盘的跨河边恰好满足，见 topology 测试）：
 *   - 我方第 5 行第 f 列 ⟷ 对岸第 5 行第 10 − f 列，跨河一步就是**列线方向的一步**；
 *   - 过河后对岸地盘相对我方旋转 180°：我方「前」= 对方「后」，我方「右」= 对方「左」。
 *   - 中路第 5 列的顶点（中央三角形的顶点）同时面对两条界河，所以「向前」有两个分支。
 *
 * 行线在第 5 列处的折角（第 2~5 行）只是扇形盘的几何变形，仍是同一条行线；
 * 第 1 列 / 第 9 列的端点就是棋盘边，行线到此为止，不会拐到渡口上。
 */
export type Dir = 'U' | 'D' | 'L' | 'R';

export const DIRS: readonly Dir[] = ['U', 'D', 'L', 'R'];

const OPPOSITE: Readonly<Record<Dir, Dir>> = { U: 'D', D: 'U', L: 'R', R: 'L' };

/** 与某方向垂直的两个方向 */
export function perpendicular(dir: Dir): readonly [Dir, Dir] {
  return dir === 'U' || dir === 'D' ? ['L', 'R'] : ['U', 'D'];
}

/** 走到的点 + 是否已处于「翻转」坐标（过了奇数次河） */
export interface FramedPoint {
  readonly id: string;
  readonly flipped: boolean;
}

/** 某点的跨河邻居（只有第 5 行有；中路顶点有两个） */
export function crossingNeighbours(id: string, config: RuleConfig = DEFAULT_RULES): readonly string[] {
  const p = POINT_BY_ID.get(id);
  if (!p || p.rank !== RANKS) return [];
  return (getAdjacency(config).get(id) ?? []).filter((nb) => POINT_BY_ID.get(nb)?.player !== p.player);
}

/**
 * 沿方向 `dir`（出发地盘坐标）走一步。`flipped` 为真时，当前点位于对岸，
 * 需把方向取反后按当前点的本地坐标走。第 5 行再「向前」就是过河，并翻转坐标。
 */
export function stepToward(
  at: FramedPoint,
  dir: Dir,
  config: RuleConfig = DEFAULT_RULES,
): readonly FramedPoint[] {
  const cur = POINT_BY_ID.get(at.id);
  if (!cur) return [];
  const local = at.flipped ? OPPOSITE[dir] : dir;
  const same = (file: number, rank: number): readonly FramedPoint[] =>
    isOnBoard(cur.player, file, rank) ? [{ id: sqId(cur.player, file, rank), flipped: at.flipped }] : [];
  switch (local) {
    case 'U':
      if (cur.rank < RANKS) return same(cur.file, cur.rank + 1);
      return crossingNeighbours(at.id, config).map((id) => ({ id, flipped: !at.flipped }));
    case 'D':
      return same(cur.file, cur.rank - 1);
    case 'L':
      return same(cur.file - 1, cur.rank);
    case 'R':
      return same(cur.file + 1, cur.rank);
  }
}

/** 连续走若干步（每步可能分叉），返回全部终点 */
function walkDirs(
  start: FramedPoint,
  dirs: readonly Dir[],
  config: RuleConfig,
): readonly FramedPoint[] {
  let cur: readonly FramedPoint[] = [start];
  for (const d of dirs) cur = cur.flatMap((p) => stepToward(p, d, config));
  return cur;
}

/**
 * 「斜一格」：先 a 后 b 与先 b 后 a 必须到达**同一点**，才算是一个真实的格子对角。
 * 这条约束自动排除中央三角顶点处那些拼不成格子的组合。
 */
function cornerOf(
  start: FramedPoint,
  a: Dir,
  b: Dir,
  config: RuleConfig,
): readonly FramedPoint[] {
  const viaB = new Set(walkDirs(start, [b, a], config).map((p) => p.id));
  return walkDirs(start, [a, b], config).filter((p) => viaB.has(p.id));
}

/** 某点出发的单步方向（用于把「首步」还原成方向） */
export function directionOf(fromId: string, toId: string, config: RuleConfig = DEFAULT_RULES): Dir | null {
  for (const d of DIRS) {
    if (stepToward({ id: fromId, flipped: false }, d, config).some((p) => p.id === toId)) return d;
  }
  return null;
}

/**
 * 兵的走法（与象棋相同，三家对称）：
 *
 *  1. **未过河（在自家地盘）**：只能向前一步。第 1~4 行是同列 rank + 1；
 *     第 5 行再向前就是过河（中路顶点可选两条界河）。未过河不能横走。
 *  2. **已过河（在任一敌家地盘）**：可向前一步（该家 rank − 1，朝其底线），
 *     也可横走一格（该家同一行）；永远不能后退——
 *     对岸坐标是翻转的，所以「再过一次河」在兵自己的坐标里就是后退，不允许。
 */
export function isForwardStep(
  player: PlayerKey,
  fromId: string,
  toId: string,
  config: RuleConfig = DEFAULT_RULES,
): boolean {
  return forwardNeighbours(player, fromId, config).includes(toId);
}

/** 某点上兵可走的邻点 */
export function forwardNeighbours(
  player: PlayerKey,
  fromId: string,
  config: RuleConfig = DEFAULT_RULES,
): readonly string[] {
  const from = POINT_BY_ID.get(fromId);
  if (!from) return [];
  const here: FramedPoint = { id: fromId, flipped: false };
  const dirs: readonly Dir[] = from.player === player ? ['U'] : ['D', 'L', 'R'];
  return dirs.flatMap((d) => stepToward(here, d, config).map((p) => p.id));
}

// ---------------------------------------------------------------------------
// 「日」字 / 「田」字 走法路径（馬与相）
// ---------------------------------------------------------------------------

/**
 * 馬走日（与象棋相同）：先沿一个正交方向走一格（这一格是**马腿**），
 * 再向外斜走一格。等价于 `(±1, ±2)` / `(±2, ±1)`，马腿在长边的第一格。
 *
 * 判定方式：起点、马腿、落点必须围成一个完整的「2 × 1」格块（两个相邻的真实格子）。
 * 在普通象棋盘上这总成立；在这张盘上它额外排除了中央三角顶点处
 * 「一边算赤壁、一边算祁山」拼出来的假日字，并保证馬的走法可逆（A 能跳到 B ⇔ B 能跳到 A）。
 *
 * 跨河时按象棋处理：跨河一步属于列线方向（纵向），对岸坐标旋转 180°。
 * 例：魏(2,4) 先走到魏(2,5)（马腿），再斜出到 蜀(9,5) 或 蜀(7,5)。
 *
 * 返回 [马腿, 落点] 列表（不含蹩腿判定）。
 */
export function horseTargets(
  from: string,
  config: RuleConfig = DEFAULT_RULES,
): readonly (readonly [string, string])[] {
  if (!POINT_BY_ID.has(from)) return [];
  const start: FramedPoint = { id: from, flipped: false };
  const reaches = (at: FramedPoint, dir: Dir, id: string) =>
    stepToward(at, dir, config).some((p) => p.id === id);
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const d of DIRS) {
    for (const side of perpendicular(d)) {
      for (const sideStart of stepToward(start, side, config)) {
        for (const leg of stepToward(start, d, config)) {
          // 第一格：起点 / 马腿 / 马腿侧点 / 起点侧点
          for (const legSide of stepToward(leg, side, config)) {
            if (!reaches(sideStart, d, legSide.id)) continue;
            // 第二格：马腿 / 长边终点 / 落点 / 马腿侧点
            for (const far of stepToward(leg, d, config)) {
              for (const landing of stepToward(far, side, config)) {
                if (landing.id === from || !reaches(legSide, d, landing.id)) continue;
                const key = `${leg.id}|${landing.id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push([leg.id, landing.id]);
              }
            }
          }
        }
      }
    }
  }
  return out;
}

/**
 * 相走田（与象棋相同）：沿对角线走两格 `(±2, ±2)`，
 * **象眼是对角线的中点 `(±1, ±1)`**，有子即塞象眼。相不过河：象眼与落点都必须在自家地盘。
 *
 * 返回 [象眼, 落点] 列表（不含塞眼判定）。
 */
export function elephantPaths(
  owner: PlayerKey,
  from: string,
  config: RuleConfig = DEFAULT_RULES,
): readonly (readonly [string, string])[] {
  const out: [string, string][] = [];
  const own = (id: string) => POINT_BY_ID.get(id)?.player === owner;
  if (!own(from)) return out;
  for (const v of ['U', 'D'] as const) {
    for (const h of ['L', 'R'] as const) {
      for (const eye of cornerOf({ id: from, flipped: false }, v, h, config)) {
        if (!own(eye.id)) continue;
        for (const landing of cornerOf(eye, v, h, config)) {
          if (own(landing.id)) out.push([eye.id, landing.id]);
        }
      }
    }
  }
  return out;
}

/**
 * 仕（与象棋相同）：沿九宫的两条斜线走一格。九宫斜线只有
 * `(4,1)-(5,2)-(6,3)` 与 `(6,1)-(5,2)-(4,3)` 两条，所以每一步都必须经过九宫中心 (5,2)。
 */
export function advisorPaths(from: string, config: RuleConfig = DEFAULT_RULES): readonly string[] {
  const p = POINT_BY_ID.get(from);
  if (!p || !p.inPalace) return [];
  const isCentre = (id: string) => {
    const q = POINT_BY_ID.get(id);
    return !!q && q.file === MID_FILE && q.rank === 2;
  };
  const out: string[] = [];
  for (const v of ['U', 'D'] as const) {
    for (const h of ['L', 'R'] as const) {
      for (const c of cornerOf({ id: from, flipped: false }, v, h, config)) {
        const q = POINT_BY_ID.get(c.id);
        if (!q || !q.inPalace || q.player !== p.player) continue;
        if (isCentre(from) || isCentre(c.id)) out.push(c.id);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 便捷查询
// ---------------------------------------------------------------------------

export const ALL_SQUARES: readonly Square[] = POINTS.map((p) => ({
  player: p.player,
  file: p.file,
  rank: p.rank,
}));

/** 某家的 45 个点 */
export function playerPoints(player: PlayerKey): readonly BoardPoint[] {
  return POINTS.filter((p) => p.player === player);
}

/** 某家的九宫 9 个点 */
export function palacePoints(player: PlayerKey): readonly BoardPoint[] {
  return POINTS.filter((p) => p.player === player && p.inPalace);
}

/** 某家地盘的边界（最内一行）两个角点 */
export function innerCorners(player: PlayerKey): readonly [BoardPoint, BoardPoint] {
  return [getPoint(player, 1, RANKS), getPoint(player, FILES, RANKS)];
}

/** 从指定起点出发，沿可通行图的最短路距离（边数） */
export function graphDistance(
  fromId: string,
  toId: string,
  config: RuleConfig = DEFAULT_RULES,
): number {
  if (fromId === toId) return 0;
  const adj = getAdjacency(config);
  const dist = new Map<string, number>([[fromId, 0]]);
  const queue: string[] = [fromId];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    const d = dist.get(cur)!;
    for (const nb of adj.get(cur) ?? []) {
      if (dist.has(nb)) continue;
      if (nb === toId) return d + 1;
      dist.set(nb, d + 1);
      queue.push(nb);
    }
  }
  return Number.POSITIVE_INFINITY;
}

export { FILES as FILES_PER_PLAYER, RANKS as RANKS_PER_PLAYER };

// ---------------------------------------------------------------------------
// SVG 像素坐标换算（与生成器一致：size=1200, margin=0.17）
// ---------------------------------------------------------------------------

/** SVG 画布边长（与 board_data.json 的生成器保持一致） */
export const SVG_SIZE = 1200;
/** 模型坐标 → SVG 时的留白（模型单位） */
export const SVG_MARGIN = 0.17;
/** 模型坐标 → SVG 像素的缩放系数 */
export const SVG_SCALE = SVG_SIZE / (2 * BOARD_RADIUS + 2 * SVG_MARGIN);

export function modelToSvg(x: number, y: number): { x: number; y: number } {
  return { x: SVG_SIZE / 2 + x * SVG_SCALE, y: SVG_SIZE / 2 + y * SVG_SCALE };
}

/** 座位顺序（0/1/2 = 魏/蜀/吴），与 apps/server 的 SEAT_TO_PLAYER 对应 */
export const SEAT_ORDER: readonly PlayerKey[] = ['wei', 'shu', 'wu'] as const;
