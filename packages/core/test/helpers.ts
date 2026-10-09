/**
 * 测试用局面构造工具
 *
 * 用法：
 *   const s = buildState({
 *     wei: ['general@5,1', 'rook@5,4'],
 *     shu: ['general@5,1'],
 *   });
 */

import { DEFAULT_RULES, PLAYER_KEYS, type GameState, type Piece, type PlayerKey, type RuleConfig } from '../src/types.ts';

const KIND_BY_GLYPH: Record<string, Piece['kind']> = {
  車: 'rook',
  车: 'rook',
  R: 'rook',
  rook: 'rook',
  馬: 'horse',
  马: 'horse',
  N: 'horse',
  horse: 'horse',
  相: 'elephant',
  象: 'elephant',
  B: 'elephant',
  elephant: 'elephant',
  仕: 'advisor',
  士: 'advisor',
  A: 'advisor',
  advisor: 'advisor',
  帥: 'general',
  帅: 'general',
  將: 'general',
  将: 'general',
  K: 'general',
  general: 'general',
  炮: 'cannon',
  砲: 'cannon',
  C: 'cannon',
  cannon: 'cannon',
  兵: 'soldier',
  卒: 'soldier',
  P: 'soldier',
  soldier: 'soldier',
};

export interface BuildOptions {
  /**
   * 每家摆哪些子。格式 `棋子名@坐标`：
   *  - 坐标可以只写 `列,行`（默认属于该家的地盘）：`車@5,2`
   *  - 也可以带地盘前缀，把子放到别家地盘上（模拟已过河的棋子）：
   *    `車@shu:5,2`（魏的子站在蜀地盘的 (5,2)）
   */
  readonly pieces: Partial<Record<PlayerKey, readonly string[]>>;
  readonly turn?: PlayerKey;
  readonly rules?: Partial<RuleConfig>;
}

export function buildState(opts: BuildOptions): GameState {
  const pieces: Record<string, Piece> = {};
  for (const owner of PLAYER_KEYS) {
    for (const spec of opts.pieces[owner] ?? []) {
      // 注意：坐标可能带地盘前缀（如 shu:5,2），所以必须从**最后一个** @ 切分
      const at = spec.lastIndexOf('@');
      if (at < 0) throw new Error(`摆子格式应为「棋子@坐标」: ${spec}`);
      const name = spec.slice(0, at).trim();
      const coordPart = spec.slice(at + 1).trim();
      const kind = KIND_BY_GLYPH[name];
      if (!kind) throw new Error(`未知棋子名: ${name}（可用：車馬相仕帥炮兵，或英文键）`);

      const colon = coordPart.indexOf(':');
      const ownerOfSquare: PlayerKey = colon >= 0 ? (coordPart.slice(0, colon) as PlayerKey) : owner;
      const coord = colon >= 0 ? coordPart.slice(colon + 1) : coordPart;
      const [file, rank] = coord.split(',').map(Number) as [number, number];
      if (!Number.isInteger(file) || !Number.isInteger(rank)) {
        throw new Error(`坐标格式应为「列,行」: ${spec}`);
      }
      pieces[`${ownerOfSquare}:${file},${rank}`] = { kind, owner };
    }
  }
  return {
    pieces,
    turn: opts.turn ?? 'wei',
    status: { wei: 'playing', shu: 'playing', wu: 'playing' },
    phase: 'playing',
    winner: null,
    ply: 0,
    consecutiveChecks: 0,
    checkStreakBy: null,
    history: [],
    events: [],
    rules: { ...DEFAULT_RULES, ...opts.rules },
  };
}
