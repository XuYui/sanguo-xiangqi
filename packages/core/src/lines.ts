/**
 * 直线运动（車 / 炮 / 飞将判定）
 *
 * 与象棋一样，一条「线」就是沿同一个正交方向一直走：
 *  - **行线**：同一家同一行的第 1~9 列。第 2~5 行在中路第 5 列有折角，
 *    那只是扇形棋盘的几何变形，仍是同一条行线（象棋的横线贯穿全盘）；
 *    行线到第 1 / 第 9 列（棋盘边）为止，不会拐上渡口或中央三角边。
 *  - **列线**：同一家同一列的第 1~5 行；第 5 行再向前就跨过界河，
 *    接到对岸第 10 − f 列，再沿对岸那一列走向其底线（象棋的纵线贯穿河界）。
 *    中路第 5 列的顶点同时面对两条界河，因此会分成两条射线。
 *  - 六边形顶点处没有拐弯：第 1 行与第 1 / 9 列是两条不同的线。
 *
 * 方向与过河换算统一由 board.ts 的 `stepToward` 负责。
 */

import {
  DIRS,
  POINT_BY_ID,
  directionOf,
  getAdjacency,
  stepToward,
  type Dir,
  type FramedPoint,
} from './board.ts';
import { DEFAULT_RULES, type RuleConfig } from './types.ts';

/**
 * 从 `from` 出发沿方向 `dir` 的全部射线（中路顶点向前过河时分叉）。
 * 遇到 `blocked` 返回 true 的点时，把该点包含进来后停止（便于車吃子、炮找炮架）。
 */
export function directionRays(
  from: string,
  dir: Dir,
  blocked: (sq: string) => boolean = () => false,
  config: RuleConfig = DEFAULT_RULES,
): readonly (readonly string[])[] {
  if (!POINT_BY_ID.has(from)) return [];
  const out: string[][] = [];
  const walk = (at: FramedPoint, path: readonly string[]) => {
    const nexts = stepToward(at, dir, config).filter((p) => p.id !== from && !path.includes(p.id));
    if (nexts.length === 0) {
      if (path.length) out.push([...path]);
      return;
    }
    for (const next of nexts) {
      const nextPath = [...path, next.id];
      if (blocked(next.id)) out.push(nextPath);
      else walk(next, nextPath);
    }
  };
  walk({ id: from, flipped: false }, []);
  return out;
}

/** 某点出发、四个方向上的全部射线 */
export function allRays(
  from: string,
  blocked: (sq: string) => boolean = () => false,
  config: RuleConfig = DEFAULT_RULES,
): readonly (readonly string[])[] {
  return DIRS.flatMap((d) => directionRays(from, d, blocked, config));
}

/**
 * 从 `from` 出发、以 `firstStep` 为第一步的射线（可能因中路顶点分叉而有多条）。
 * 保留旧接口：调用方只知道「第一步」时用它。
 */
export function rayPaths(
  from: string,
  firstStep: string,
  blocked: (sq: string) => boolean = () => false,
  config: RuleConfig = DEFAULT_RULES,
): readonly (readonly string[])[] {
  const dir = directionOf(from, firstStep, config);
  if (!dir) return [];
  return directionRays(from, dir, blocked, config).filter((line) => line[0] === firstStep);
}

/**
 * 从 `from` 出发、沿 `firstStep` 方向，返回这条射线经过的所有交叉点（含 firstStep）。
 * 不负责棋规，只负责「几何上同一条直线上的序列」。
 */
export function ray(
  from: string,
  firstStep: string,
  blocked: (sq: string) => boolean = () => false,
  config: RuleConfig = DEFAULT_RULES,
): readonly string[] {
  return rayPaths(from, firstStep, blocked, config)[0] ?? [];
}

/** 某个点在几何上允许出发的所有「第一步」（也就是它的全部邻居） */
export function firstSteps(id: string, config: RuleConfig = DEFAULT_RULES): readonly string[] {
  return getAdjacency(config).get(id) ?? [];
}

/**
 * 車的滑行：沿每个方向前进，直到遇到第一个有子的点（可吃）。
 */
export function rookSlides(
  from: string,
  occupied: (sq: string) => boolean,
  config: RuleConfig = DEFAULT_RULES,
): readonly string[] {
  return [...new Set(allRays(from, occupied, config).flat())];
}

/**
 * 炮的走法：空格处可走（不能吃）；越过第一个子（炮架）后，第一个遇到的子可吃。
 */
export function cannonMoves(
  from: string,
  occupied: (sq: string) => boolean,
  config: RuleConfig = DEFAULT_RULES,
): { quiet: readonly string[]; captures: readonly string[] } {
  const quiet: string[] = [];
  const captures: string[] = [];
  for (const seq of allRays(from, () => false, config)) {
    // 每条分支独立处理「炮架 + 架后第一子」。
    let passedScreen = false;
    for (const sq of seq) {
      const occ = occupied(sq);
      if (!passedScreen) {
        if (occ) passedScreen = true; // 这个子就是炮架
        else quiet.push(sq);
      } else if (occ) {
        captures.push(sq); // 隔一子吃
        break;
      }
    }
  }
  return { quiet: [...new Set(quiet)], captures: [...new Set(captures)] };
}
