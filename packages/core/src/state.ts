/**
 * 对局状态机
 *
 * 职责：
 *  - 生成**合法**走法（含挡将、飞将判定）
 *  - 应用走子并结算事件（吃子 / 将军 / 将死淘汰 / 长将判负 / 结束）
 *  - 轮转回合，自动跳过已出局的一方
 *
 * 三人象棋的胜负结算规则（已与用户逐条确认，见 SPEC.md §4）：
 *  1. 被将死的一方**立即出局**，棋子全部移除，剩余两家继续；
 *  2. 最后存活者胜；
 *  3. 困毙（轮到自己时无任何合法走法）= 判负出局；
 *  4. 长将判负：连续将军达到上限（默认 6 次）判负出局；
 *  5. 飞将（将帅不得照面）：三方两两判定，不允许形成两帥在同一直线上
 *     且中间无子的局面。
 *
 * 实现注记：飛将规则被实现为「局面合法性」约束，因此**任何导致飞将的走法
 * 都不合法**（等价于象棋里不能主动送将）。
 */

import {
  PLAYERS,
  POINT_BY_ID,
  TURN_ORDER,
  nextPlayer,
  playerPoints,
} from './board.ts';
import { allRays } from './lines.ts';
import { movesFor } from './moves.ts';
import {
  DEFAULT_RULES,
  PLAYER_KEYS,
  type GameEvent,
  type GameState,
  type Move,
  type MoveRecord,
  type Piece,
  type PlayerKey,
  type PlayerStatus,
  type RuleConfig,
  type Square,
} from './types.ts';

// ---------------------------------------------------------------------------
// 初始局面
// ---------------------------------------------------------------------------

/** 标准象棋半边摆法（三家相同）；坐标 = 该家本地 (file, rank) */
export const INITIAL_LAYOUT: readonly { file: number; rank: number; kind: Piece['kind'] }[] = [
  { file: 1, rank: 1, kind: 'rook' },
  { file: 2, rank: 1, kind: 'horse' },
  { file: 3, rank: 1, kind: 'elephant' },
  { file: 4, rank: 1, kind: 'advisor' },
  { file: 5, rank: 1, kind: 'general' },
  { file: 6, rank: 1, kind: 'advisor' },
  { file: 7, rank: 1, kind: 'elephant' },
  { file: 8, rank: 1, kind: 'horse' },
  { file: 9, rank: 1, kind: 'rook' },
  { file: 2, rank: 3, kind: 'cannon' },
  { file: 8, rank: 3, kind: 'cannon' },
  { file: 1, rank: 4, kind: 'soldier' },
  { file: 3, rank: 4, kind: 'soldier' },
  { file: 5, rank: 4, kind: 'soldier' },
  { file: 7, rank: 4, kind: 'soldier' },
  { file: 9, rank: 4, kind: 'soldier' },
];

export function sq(player: PlayerKey, file: number, rank: number): Square {
  return { player, file, rank };
}

export function idOf(s: Square): string {
  return `${s.player}:${s.file},${s.rank}`;
}

export function parseId(id: string): Square {
  const [player, rest] = id.split(':') as [PlayerKey, string];
  const [file, rank] = rest.split(',').map(Number) as [number, number];
  return { player, file, rank };
}

export function createInitialState(rules: RuleConfig = DEFAULT_RULES): GameState {
  const pieces: Record<string, Piece> = {};
  for (const owner of PLAYER_KEYS) {
    for (const { file, rank, kind } of INITIAL_LAYOUT) {
      pieces[idOf(sq(owner, file, rank))] = { kind, owner };
    }
  }
  return {
    pieces,
    turn: TURN_ORDER[0]!,
    status: { wei: 'playing', shu: 'playing', wu: 'playing' },
    phase: 'playing',
    winner: null,
    ply: 0,
    consecutiveChecks: 0,
    checkStreakBy: null,
    history: [],
    events: [],
    rules,
  };
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function pieceAt(state: GameState, id: string): Piece | undefined {
  return state.pieces[id];
}

export function isAlive(state: GameState, p: PlayerKey): boolean {
  return state.status[p] === 'playing';
}

export function alivePlayers(state: GameState): readonly PlayerKey[] {
  return PLAYER_KEYS.filter((k) => isAlive(state, k));
}

/** 找到某家的帥（已经被吃则返回 undefined） */
export function findGeneral(state: GameState, owner: PlayerKey): string | undefined {
  for (const [id, p] of Object.entries(state.pieces)) {
    if (p.kind === 'general' && p.owner === owner) return id;
  }
  return undefined;
}

export function allPiecesOf(state: GameState, owner: PlayerKey): readonly string[] {
  return Object.entries(state.pieces)
    .filter(([, p]) => p.owner === owner)
    .map(([id]) => id);
}

// ---------------------------------------------------------------------------
// 攻击判定 / 将军 / 飞将
// ---------------------------------------------------------------------------

/**
 * 某点是否被 `by` 方的棋子攻击（伪合法，不考虑挡将）。
 * 注意：兵的走法包含「前进方向」，所以要用兵主人的规则来生成。
 */
export function isAttackedBy(state: GameState, target: string, by: PlayerKey): boolean {
  const occ = (sq2: string) => state.pieces[sq2] !== undefined;
  for (const from of allPiecesOf(state, by)) {
    const piece = state.pieces[from]!;
    const m = movesFor(piece, from, occ, state.rules);
    if (m.quiet.includes(target) || m.captures.includes(target)) return true;
  }
  return false;
}

/** 某家是否正被将军（任一存活对手能吃到其帥） */
export function isInCheck(state: GameState, who: PlayerKey): boolean {
  const general = findGeneral(state, who);
  if (!general) return true; // 帥已被吃：视为被将军（等同败）
  return PLAYER_KEYS.some(
    (other) => other !== who && isAlive(state, other) && isAttackedBy(state, general, other),
  );
}

/** 正在将军 `who` 的所有对手 */
export function checkers(state: GameState, who: PlayerKey): readonly PlayerKey[] {
  const general = findGeneral(state, who);
  if (!general) return [];
  return PLAYER_KEYS.filter(
    (other) => other !== who && isAlive(state, other) && isAttackedBy(state, general, other),
  );
}

/**
 * 两个帥是否照面（飞将）：沿几何直线能从一个帥走到另一个帥，且中间没有任何棋子。
 * 直线由 `allRays` 追踪（列线可跨河、中路顶点会分叉），遇到棋子即停。
 * 两个帥分处两家九宫，只可能在**跨河的同一列线**上照面（我方第 f 列 = 对方第 10 − f 列）。
 */
export function generalsFace(state: GameState, a: PlayerKey, b: PlayerKey): boolean {
  const ga = findGeneral(state, a);
  const gb = findGeneral(state, b);
  if (!ga || !gb || ga === gb) return false;

  const occ = (sq2: string) => state.pieces[sq2] !== undefined;
  // allRays 会在第一个有子的点停止，所以 gb 出现在射线上 = 中间无子
  return allRays(ga, occ, state.rules).some((line) => line.includes(gb));
}

/** 是否违反了飞将规则（任一对存活势力的帥照面） */
export function violatesFlyingGeneral(state: GameState): boolean {
  if (!state.rules.flyingGeneral) return false;
  const alive = alivePlayers(state);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      if (generalsFace(state, alive[i]!, alive[j]!)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 走法生成（含合法性过滤）
// ---------------------------------------------------------------------------

/** 伪合法走法（不检查挡将 / 飞将，但要排除吃自己的子） */
export function pseudoMovesFrom(state: GameState, from: string): Move[] {
  const piece = state.pieces[from];
  if (!piece) return [];
  const occ = (sq2: string) => state.pieces[sq2] !== undefined;
  const m = movesFor(piece, from, occ, state.rules);
  const out: Move[] = [];
  for (const to of m.quiet) out.push({ from: parseId(from), to: parseId(to) });
  for (const to of m.captures) {
    const captured = state.pieces[to];
    // 走法生成只按「有子」判定，吃自己子要在这里排除
    if (captured && captured.owner === piece.owner) continue;
    out.push({ from: parseId(from), to: parseId(to), ...(captured ? { captured } : {}) });
  }
  return out;
}

/** 应用一步棋到「棋盘子集」上（不结算事件），返回新棋盘的浅拷贝 */
function applyToPieces(
  pieces: Readonly<Record<string, Piece>>,
  move: Move,
): Record<string, Piece> {
  const next: Record<string, Piece> = { ...pieces };
  const fromId = idOf(move.from);
  const toId = idOf(move.to);
  const moving = next[fromId];
  if (moving) {
    delete next[fromId];
    next[toId] = moving;
  }
  return next;
}

/** 某个棋子布局是否让 `who` 处于非法状态（被将军或飞将） */
function positionIllegal(
  base: GameState,
  pieces: Readonly<Record<string, Piece>>,
  who: PlayerKey,
): boolean {
  const probe: GameState = { ...base, pieces };
  if (isInCheck(probe, who)) return true;
  if (probe.rules.flyingGeneral && violatesFlyingGeneral(probe)) return true;
  return false;
}

/** 仅供测试：暴露非法局面判定 */
export function isPositionIllegalFor(
  base: GameState,
  pieces: Readonly<Record<string, Piece>>,
  who: PlayerKey,
): boolean {
  return positionIllegal(base, pieces, who);
}

/** 某家全部合法走法（自己走完后不能让自己被将军，也不能形成飞将） */
export function legalMoves(state: GameState, who: PlayerKey = state.turn): Move[] {
  if (!isAlive(state, who)) return [];
  const out: Move[] = [];
  for (const from of allPiecesOf(state, who)) {
    for (const move of pseudoMovesFrom(state, from)) {
      const pieces = applyToPieces(state.pieces, move);
      if (!positionIllegal(state, pieces, who)) out.push(move);
    }
  }
  return out;
}

/** 某个点的全部合法走法（UI 选中棋子时调用） */
export function legalMovesFrom(state: GameState, from: string): Move[] {
  const piece = state.pieces[from];
  if (!piece) return [];
  const out: Move[] = [];
  for (const move of pseudoMovesFrom(state, from)) {
    const pieces = applyToPieces(state.pieces, move);
    if (!positionIllegal(state, pieces, piece.owner)) out.push(move);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 结算
// ---------------------------------------------------------------------------

export type MoveResult =
  | { readonly ok: true; readonly state: GameState; readonly events: readonly GameEvent[] }
  | { readonly ok: false; readonly error: string };

/** 走法记号（简化版：棋子名 + 起止坐标，便于棋谱阅读） */
export function notationOf(state: GameState, move: Move): string {
  const piece = state.pieces[idOf(move.from)];
  const glyph: Record<Piece['kind'], string> = {
    rook: '車',
    horse: '馬',
    elephant: '相',
    advisor: '仕',
    general: '帥',
    cannon: '炮',
    soldier: '兵',
  };
  const name = piece ? glyph[piece.kind] : '?';
  const cap = state.pieces[idOf(move.to)];
  const arrow = cap ? '×' : '-';
  return `${PLAYERS[move.from.player].name}${name}(${move.from.file},${move.from.rank})${arrow}(${move.to.file},${move.to.rank})`;
}

/**
 * 应用一步棋。会完整结算：吃子 / 将军 / 将死淘汰 / 长将 / 结束。
 */
export function applyMove(state: GameState, move: Move): MoveResult {
  if (state.phase !== 'playing') return { ok: false, error: '对局已结束' };

  const piece = state.pieces[idOf(move.from)];
  if (!piece) return { ok: false, error: `起点没有棋子: ${idOf(move.from)}` };
  if (piece.owner !== state.turn) {
    return { ok: false, error: `现在不是 ${PLAYERS[piece.owner].name} 的回合` };
  }
  if (!isAlive(state, piece.owner)) return { ok: false, error: `${PLAYERS[piece.owner].name} 已出局` };
  if (idOf(move.from) === idOf(move.to)) return { ok: false, error: '起点与终点相同' };

  const target = state.pieces[idOf(move.to)];
  if (target && target.owner === piece.owner) return { ok: false, error: '不能吃自己的棋子' };

  // 目标点必须真实存在
  const toId = idOf(move.to);
  if (!POINT_BY_ID.has(toId)) return { ok: false, error: `不存在的落点: ${toId}` };

  // 这一步必须符合该棋子的走法规则（联机层会收到外部输入，绝不能跳过）
  const pseudo = pseudoMovesFrom(state, idOf(move.from));
  if (!pseudo.some((m) => idOf(m.to) === toId)) {
    return { ok: false, error: '不符合该棋子的走法规则' };
  }

  // 合法性：走完不能让自己被将军 / 飞将
  const pieces = applyToPieces(state.pieces, move);
  if (positionIllegal(state, pieces, piece.owner)) {
    return { ok: false, error: '这一步会让自己被将军（或将帅照面）' };
  }

  const by = piece.owner;
  const events: GameEvent[] = [];
  const next: {
    pieces: Record<string, Piece>;
    status: Record<PlayerKey, PlayerStatus>;
    turn: PlayerKey;
    phase: GameState['phase'];
    winner: PlayerKey | null;
    ply: number;
    consecutiveChecks: number;
    checkStreakBy: PlayerKey | null;
  } = {
    pieces,
    status: { ...state.status },
    turn: state.turn,
    phase: state.phase,
    winner: state.winner,
    ply: state.ply + 1,
    consecutiveChecks: state.consecutiveChecks,
    checkStreakBy: state.checkStreakBy,
  };

  events.push({ type: 'move', by, from: move.from, to: move.to });
  if (target) {
    events.push({ type: 'capture', by, piece: target, at: move.to });
  }

  // ---- 结算：谁被将军 ----
  const probe = (): GameState => ({ ...state, ...next, events: [], history: [] });
  const checked = PLAYER_KEYS.filter(
    (k) => k !== by && isAlive(probe(), k) && isInCheck(probe(), k),
  );
  const eliminated: PlayerKey[] = [];
  for (const victim of checked) {
    events.push({ type: 'check', by, victim });
  }

  // ---- 长将：连续将军累计 ----
  if (checked.length > 0 && state.checkStreakBy === by) {
    next.consecutiveChecks = state.consecutiveChecks + 1;
  } else if (checked.length > 0) {
    next.consecutiveChecks = 1;
    next.checkStreakBy = by;
  } else {
    next.consecutiveChecks = 0;
    next.checkStreakBy = null;
  }

  const limit = state.rules.maxConsecutiveChecks;
  if (limit > 0 && next.consecutiveChecks >= limit && next.checkStreakBy) {
    const loser = next.checkStreakBy;
    next.status[loser] = 'longCheck';
    eliminated.push(loser);
    next.consecutiveChecks = 0;
    next.checkStreakBy = null;
  }

  // ---- 将被将死 / 困毙的一方出局 ----
  // 判定「下一个该走的人」：如果没有合法走法，则出局（被将军 = 将死；否则 = 困毙）
  if (next.status[by] === 'playing') {
    let cursor = nextPlayer(by);
    // 最多绕一圈，处理「连续多家出局」的情况
    for (let guard = 0; guard < TURN_ORDER.length; guard++) {
      if (next.status[cursor] !== 'playing') {
        cursor = nextPlayer(cursor);
        continue;
      }
      const probeState: GameState = { ...state, ...next, turn: cursor, events: [], history: [] };
      const moves = legalMoves(probeState, cursor);
      if (moves.length > 0) break; // 该家有棋可走，回合交给他
      const inCheck = isInCheck(probeState, cursor);
      const reason: PlayerStatus = inCheck ? 'checkmated' : 'stalemated';
      if (state.rules.eliminateOnCheckmate) {
        next.status[cursor] = reason;
        eliminated.push(cursor);
      } else {
        break; // 未开启立即淘汰：保持原样，交给上层处理
      }
      cursor = nextPlayer(cursor);
    }
    next.turn = cursor;
  }

  // ---- 出局者棋子全部移除 ----
  for (const who of eliminated) {
    for (const id of allPiecesOf({ ...state, ...next } as GameState, who)) {
      delete next.pieces[id];
    }
    events.push({ type: 'eliminated', who, reason: next.status[who]! });
  }

  // ---- 结束判定 ----
  const survivors = PLAYER_KEYS.filter((k) => next.status[k] === 'playing');
  if (survivors.length <= 1) {
    next.phase = 'finished';
    next.winner = survivors[0] ?? null;
    events.push({
      type: 'gameOver',
      winner: next.winner,
      reason:
        survivors.length === 0
          ? '三家全部出局'
          : `${PLAYERS[survivors[0]!].name} 成为最后的存活者`,
    });
  }

  const record: MoveRecord = {
    move,
    by,
    notation: notationOf(state, move),
    gaveCheck: checked,
    eliminated,
    at: next.ply,
  };

  const finalState: GameState = {
    ...state,
    ...next,
    history: [...state.history, record],
    events: [...state.events, ...events],
  };
  return { ok: true, state: finalState, events };
}

/** 认输（联机层用） */
export function resign(state: GameState, who: PlayerKey): MoveResult {
  if (state.phase !== 'playing') return { ok: false, error: '对局已结束' };
  if (!isAlive(state, who)) return { ok: false, error: `${PLAYERS[who].name} 已出局` };
  const status = { ...state.status, [who]: 'resigned' as PlayerStatus };
  const events: GameEvent[] = [{ type: 'eliminated', who, reason: 'resigned' }];
  const pieces = { ...state.pieces };
  for (const id of allPiecesOf(state, who)) delete pieces[id];

  const survivors = PLAYER_KEYS.filter((k) => status[k] === 'playing');
  let phase: GameState['phase'] = state.phase;
  let winner: PlayerKey | null = state.winner;
  let turn = state.turn;
  if (survivors.length <= 1) {
    phase = 'finished';
    winner = survivors[0] ?? null;
    events.push({
      type: 'gameOver',
      winner,
      reason: survivorReason(survivors),
    });
  } else if (who === state.turn) {
    turn = nextPlayer(who);
  }
  return {
    ok: true,
    state: { ...state, pieces, status, phase, winner, turn, events: [...state.events, ...events] },
    events,
  };
}

function survivorReason(survivors: readonly PlayerKey[]): string {
  if (survivors.length === 0) return '三家全部出局';
  return `${PLAYERS[survivors[0]!].name} 成为最后的存活者`;
}

// ---------------------------------------------------------------------------
// 便于 UI / 测试的摘要
// ---------------------------------------------------------------------------

export interface StateSummary {
  readonly turn: PlayerKey;
  readonly phase: GameState['phase'];
  readonly winner: PlayerKey | null;
  readonly status: Readonly<Record<PlayerKey, PlayerStatus>>;
  readonly aliveCount: number;
  readonly legalMoveCount: number;
  readonly inCheck: readonly PlayerKey[];
  readonly flyingGeneral: boolean;
}

export function summarize(state: GameState): StateSummary {
  const inCheck = PLAYER_KEYS.filter((k) => isAlive(state, k) && isInCheck(state, k));
  return {
    turn: state.turn,
    phase: state.phase,
    winner: state.winner,
    status: state.status,
    aliveCount: alivePlayers(state).length,
    legalMoveCount: legalMoves(state).length,
    inCheck,
    flyingGeneral: violatesFlyingGeneral(state),
  };
}

/** 某家的棋子列表（UI 渲染用） */
export function piecesOf(state: GameState, owner: PlayerKey): readonly { id: string; piece: Piece }[] {
  return Object.entries(state.pieces)
    .filter(([, p]) => p.owner === owner)
    .map(([id, piece]) => ({ id, piece }));
}

/** 全部有子的点（UI 渲染用） */
export function occupiedPoints(state: GameState): readonly { id: string; piece: Piece }[] {
  return Object.entries(state.pieces).map(([id, piece]) => ({ id, piece }));
}

export { POINT_BY_ID, playerPoints };
