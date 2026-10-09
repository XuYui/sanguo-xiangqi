/**
 * 三人象棋 —— 核心类型定义
 *
 * 坐标约定（全部沿用实物棋盘与 board_data.json）：
 *  - 每家本地坐标 (file, rank)，file = 1..9（自该家左手边起），rank = 1..5（1 = 底线，5 = 最内一行）
 *  - 135 个交叉点 = 3 家 × 9 列 × 5 行，任意时刻每点最多 1 枚棋子
 *  - 模型坐标 x/y：原点为棋盘中心，y 轴向下，外接圆半径 R = 1
 */

/** 三个势力 */
export type PlayerKey = 'wei' | 'shu' | 'wu';

export const PLAYER_KEYS: readonly PlayerKey[] = ['wei', 'shu', 'wu'] as const;

/** 棋子种类（用国际通用的英文键，避免繁简/异体字形问题） */
export type PieceKind =
  | 'rook' // 車
  | 'horse' // 馬
  | 'elephant' // 相
  | 'advisor' // 仕
  | 'general' // 帥
  | 'cannon' // 炮
  | 'soldier'; // 兵

export const PIECE_KINDS: readonly PieceKind[] = [
  'rook',
  'horse',
  'elephant',
  'advisor',
  'general',
  'cannon',
  'soldier',
] as const;

/** 某一枚棋子 */
export interface Piece {
  readonly kind: PieceKind;
  readonly owner: PlayerKey;
}

/** 落点：势力 + 该家本地坐标 */
export interface Square {
  readonly player: PlayerKey;
  readonly file: number; // 1..9
  readonly rank: number; // 1..5
}

/** 棋盘上的一个交叉点（静态几何信息） */
export interface BoardPoint extends Square {
  /** 全局唯一 id，形如 "wei:5,1" —— 用于 Map 键与前端 data 属性 */
  readonly id: string;
  /** 模型坐标 */
  readonly x: number;
  readonly y: number;
  /** 该点是否属于本家的九宫（第 4~6 列 × 第 1~3 行） */
  readonly inPalace: boolean;
  /** 是否底线（rank = 1） */
  readonly onBackRank: boolean;
  /** 是否最内一行（rank = 5，即界河内侧边界所在行） */
  readonly onRiverRank: boolean;
}

/** 一条边（相邻关系） */
export interface Edge {
  readonly a: string;
  readonly b: string;
  /** 'grid' = 本家格线相邻；'crossing' = 界河跨越 */
  readonly kind: 'grid' | 'crossing';
}

/** 界河定义 */
export interface RiverDef {
  readonly key: 'chibi' | 'qishan' | 'jingzhou';
  readonly name: string; // 赤壁 / 祁山 / 荆州
  readonly between: readonly [PlayerKey, PlayerKey];
  /** 两侧的跨越点对（河口） */
  readonly crossings: readonly (readonly [string, string])[];
}

/** 一个落点（起点 -> 终点），棋规层的基本单位 */
export interface Move {
  readonly from: Square;
  readonly to: Square;
  /** 被吃掉的棋子（如果有） */
  readonly captured?: Piece;
}

/** 对局方（含未来的联盟/观战者扩展） */
export interface PlayerInfo {
  readonly key: PlayerKey;
  readonly name: string; // 魏 / 蜀 / 吴
  readonly colour: string;
  /** 该家地盘的旋转角（模型坐标），用于前端排版 */
  readonly rotationDeg: number;
  /** 两个邻家（按棋盘顺时针：[下一个, 上一个]） */
  readonly neighbours: readonly [PlayerKey, PlayerKey];
  readonly rankLetters: readonly string[]; // rank 1..5 的字母，如魏 = E D C B A
}

/** 规则配置（可切换项，便于实物规则微调） */
export interface RuleConfig {
  /** 是否启用「将帅不得照面」（三方两两判定） */
  readonly flyingGeneral: boolean;
  /** 长将判负的连续将军次数上限（0 = 关闭） */
  readonly maxConsecutiveChecks: number;
  /** 被将死是否立即出局（棋子移除） */
  readonly eliminateOnCheckmate: boolean;
}

export const DEFAULT_RULES: RuleConfig = {
  flyingGeneral: true,
  maxConsecutiveChecks: 6,
  eliminateOnCheckmate: true,
};

// ---------------------------------------------------------------------------
// 对局状态
// ---------------------------------------------------------------------------

/** 一方在对局中的处境 */
export type PlayerStatus =
  | 'playing' // 存活、对局中
  | 'checkmated' // 被将死（已出局，棋子已移除）
  | 'stalemated' // 困毙（无合法走法，判负出局）
  | 'resigned' // 认输
  | 'longCheck' // 长将判负
  | 'left'; // 中途退出（联机层用）

/** 对局阶段 */
export type GamePhase = 'playing' | 'finished';

/** 对局中发生的事件（供 UI 提示与棋谱记录） */
export type GameEvent =
  | { readonly type: 'move'; readonly by: PlayerKey; readonly from: Square; readonly to: Square }
  | { readonly type: 'capture'; readonly by: PlayerKey; readonly piece: Piece; readonly at: Square }
  | { readonly type: 'check'; readonly by: PlayerKey; readonly victim: PlayerKey }
  | { readonly type: 'eliminated'; readonly who: PlayerKey; readonly reason: PlayerStatus }
  | { readonly type: 'gameOver'; readonly winner: PlayerKey | null; readonly reason: string };

/** 一步棋的完整记录 */
export interface MoveRecord {
  readonly move: Move;
  readonly by: PlayerKey;
  /** 该步棋的走法记号（如「車二平五」的简化版），由引擎生成 */
  readonly notation: string;
  readonly gaveCheck: readonly PlayerKey[];
  readonly eliminated: readonly PlayerKey[];
  readonly at: number; // 步序（从 1 开始）
}

/** 完整对局状态（可 JSON 序列化，便于联机广播与持久化） */
export interface GameState {
  /** 棋盘：点 id -> 棋子（不存在的点 = 空） */
  readonly pieces: Readonly<Record<string, Piece>>;
  /** 轮到谁 */
  readonly turn: PlayerKey;
  /** 每家的处境 */
  readonly status: Readonly<Record<PlayerKey, PlayerStatus>>;
  readonly phase: GamePhase;
  readonly winner: PlayerKey | null;
  /** 已走步数 */
  readonly ply: number;
  /** 连续将军计数：连续将军方 -> 次数（用于长将判负） */
  readonly consecutiveChecks: number;
  /** 最近一个「连续将军」的施加者 */
  readonly checkStreakBy: PlayerKey | null;
  readonly history: readonly MoveRecord[];
  readonly events: readonly GameEvent[];
  readonly rules: RuleConfig;
}
