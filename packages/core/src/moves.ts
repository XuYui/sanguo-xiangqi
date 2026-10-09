/**
 * 走法生成（不判将军，只判棋子自身的走法规则）
 *
 * 各棋子规则与象棋一致，只是映射到这张六边形棋盘（映射见 board.ts 的 stepToward）：
 *  - 車：沿行线 / 列线滑行（列线可跨河接到对岸第 10 − f 列），遇子停、可吃子。
 *  - 炮：同車滑行；不吃子时只能走空格，吃子必须隔一个「炮架」。
 *  - 馬：走「日」字，马腿是长边方向的第一格，蹩马腿则不能走；可跨河。
 *  - 相：走「田」字（斜走两格），象眼是对角中点，塞象眼则不能走；不过河。
 *  - 仕：沿九宫斜线走一格（每一步都经过九宫中心）。
 *  - 帥：九宫内直走一格，不出九宫。
 *  - 兵：未过河只能向前；过河后可向前或横走；永不后退（见 board.ts 的 forwardNeighbours）。
 */

import {
  FILES_PER_PLAYER,
  PLAYERS,
  POINT_BY_ID,
  RANKS_PER_PLAYER,
  advisorPaths,
  distance,
  elephantPaths,
  forwardNeighbours,
  horseTargets,
  type Vec,
} from './board.ts';
import { cannonMoves, firstSteps, ray, rookSlides } from './lines.ts';
import { DEFAULT_RULES, PLAYER_KEYS, type Piece, type RuleConfig } from './types.ts';
export { horseTargets };
/** 查询某点上的棋子（undefined = 空点） */
export type Occupancy = (sq: string) => boolean;
/** 查询某点上的棋子对象 */
export type PieceLookup = (sq: string) => Piece | undefined;

export interface MoveSet {
  /** 不吃子的落点 */
  readonly quiet: readonly string[];
  /** 吃子落点（不含被吃棋子信息，由上层补） */
  readonly captures: readonly string[];
}

const EMPTY: MoveSet = { quiet: [], captures: [] };

function dedupe(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

// ---------------------------------------------------------------------------
// 車
// ---------------------------------------------------------------------------

export function rookMoves(from: string, occ: Occupancy, config: RuleConfig = DEFAULT_RULES): MoveSet {
  const quiet: string[] = [];
  const captures: string[] = [];
  for (const sq of rookSlides(from, occ, config)) {
    (occ(sq) ? captures : quiet).push(sq);
  }
  return { quiet: dedupe(quiet), captures: dedupe(captures) };
}

// ---------------------------------------------------------------------------
// 炮
// ---------------------------------------------------------------------------

export function cannonMoveSet(
  from: string,
  occ: Occupancy,
  config: RuleConfig = DEFAULT_RULES,
): MoveSet {
  const { quiet, captures } = cannonMoves(from, occ, config);
  return { quiet: dedupe(quiet), captures: dedupe(captures) };
}

// ---------------------------------------------------------------------------
// 馬
// ---------------------------------------------------------------------------

/** 馬：日字落点由 board.ts 的 horseTargets 给出，这里只判蹩马腿与吃子 */
export function horseMoves(
  from: string,
  occ: Occupancy,
  config: RuleConfig = DEFAULT_RULES,
): MoveSet {
  const quiet: string[] = [];
  const captures: string[] = [];
  for (const [leg, landing] of horseTargets(from, config)) {
    if (occ(leg)) continue; // 蹩马腿
    (occ(landing) ? captures : quiet).push(landing);
  }
  return { quiet: dedupe(quiet), captures: dedupe(captures) };
}

// ---------------------------------------------------------------------------
// 相 / 象
// ---------------------------------------------------------------------------

/**
 * 相/象的「田」字目标：[象眼, 落点]。
 *
 * 与标准象棋一致：斜走两格 (±2, ±2)，象眼是对角中点 (±1, ±1)；
 * 相不过河：象眼与落点都必须在自家地盘内（由 elephantPaths 过滤）。
 *
 * 注意：这里不判定塞象眼，由 elephantMoves 结合棋盘占用判断。
 */
export function elephantTargets(
  owner: string,
  from: string,
  config: RuleConfig = DEFAULT_RULES,
): readonly (readonly [string, string])[] {
  return elephantPaths(owner as never, from, config);
}

export function elephantMoves(
  owner: string,
  from: string,
  occ: Occupancy,
  config: RuleConfig = DEFAULT_RULES,
): MoveSet {
  const quiet: string[] = [];
  const captures: string[] = [];
  for (const [eye, landing] of elephantTargets(owner, from, config)) {
    if (occ(eye)) continue; // 塞象眼
    (occ(landing) ? captures : quiet).push(landing);
  }
  return { quiet: dedupe(quiet), captures: dedupe(captures) };
}

// ---------------------------------------------------------------------------
// 仕 / 士
// ---------------------------------------------------------------------------

/**
 * 仕的落点：沿九宫斜线走一格。九宫斜线只有两条且都经过中心 (5,2)，
 * 所以只有「中心 ⟷ 四角」这 4 种走法；仕斜走没有中间点，不存在阻挡。
 */
export function advisorTargets(from: string, config: RuleConfig = DEFAULT_RULES): readonly string[] {
  return dedupe(advisorPaths(from, config));
}

export function advisorMoves(from: string, occ: Occupancy, config: RuleConfig = DEFAULT_RULES): MoveSet {
  const quiet: string[] = [];
  const captures: string[] = [];
  for (const sq of advisorTargets(from, config)) {
    (occ(sq) ? captures : quiet).push(sq);
  }
  return { quiet: dedupe(quiet), captures: dedupe(captures) };
}

// ---------------------------------------------------------------------------
// 帥 / 將
// ---------------------------------------------------------------------------

/** 帥的落点：自家九宫内直走一格 */
export function generalTargets(from: string, config: RuleConfig = DEFAULT_RULES): readonly string[] {
  return firstSteps(from, config).filter((nb) => POINT_BY_ID.get(nb)!.inPalace);
}

export function generalMoves(from: string, occ: Occupancy, config: RuleConfig = DEFAULT_RULES): MoveSet {
  const quiet: string[] = [];
  const captures: string[] = [];
  for (const sq of generalTargets(from, config)) {
    (occ(sq) ? captures : quiet).push(sq);
  }
  return { quiet: dedupe(quiet), captures: dedupe(captures) };
}

// ---------------------------------------------------------------------------
// 兵 / 卒
// ---------------------------------------------------------------------------

export function soldierMoves(
  owner: string,
  from: string,
  occ: Occupancy,
  config: RuleConfig = DEFAULT_RULES,
): MoveSet {
  const quiet: string[] = [];
  const captures: string[] = [];
  for (const nb of forwardNeighbours(owner as never, from, config)) {
    (occ(nb) ? captures : quiet).push(nb);
  }
  return { quiet: dedupe(quiet), captures: dedupe(captures) };
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

export function movesFor(
  piece: Piece,
  from: string,
  occ: Occupancy,
  config: RuleConfig = DEFAULT_RULES,
): MoveSet {
  // 起点必须是棋盘上真实存在的点。联机层会收到外部输入，
  // 这里必须软失败而不是抛异常（否则畸形请求会打崩服务端）。
  if (!POINT_BY_ID.has(from)) return EMPTY;
  switch (piece.kind) {
    case 'rook':
      return rookMoves(from, occ, config);
    case 'cannon':
      return cannonMoveSet(from, occ, config);
    case 'horse':
      return horseMoves(from, occ, config);
    case 'elephant':
      return elephantMoves(piece.owner, from, occ, config);
    case 'advisor':
      return advisorMoves(from, occ, config);
    case 'general':
      return generalMoves(from, occ, config);
    case 'soldier':
      return soldierMoves(piece.owner, from, occ, config);
    default:
      return EMPTY;
  }
}

/** 供调试：把某点的全部直线射线打出来 */
export function debugRays(from: string, occ: Occupancy, config: RuleConfig = DEFAULT_RULES): string {
  return firstSteps(from, config)
    .map((s) => `${from} ->${s}: ${ray(from, s, occ, config).join(' ')}`)
    .join('\n');
}

export { PLAYERS, PLAYER_KEYS, FILES_PER_PLAYER, RANKS_PER_PLAYER, distance, type Vec };
export { DEFAULT_RULES };
