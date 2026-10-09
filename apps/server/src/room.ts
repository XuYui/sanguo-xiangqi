/**
 * 房间引擎（纯逻辑，不依赖任何网络框架）
 *
 * 设计原则：房间只处理消息、产出消息。
 *  - 入站：客户端发来的 ClientMsg
 *  - 出站：定向回复（ReplyMsg）与广播（BroadcastMsg）
 * Socket.IO 层只负责把消息送进 `handle()`、把产出送出去。
 * 这样房间逻辑可以完全用单元测试覆盖，也让未来换传输层不需要改规则代码。
 *
 * 身份模型：
 *  - 已登录账号以账号 id 作为稳定的房间成员 id；加入房间时仍发放房间 token，
 *    浏览器凭 token 断线重连回原座位；
 *  - 未登录访客使用一次性连接 id，只能观战，不能落座参战；
 *  - 观战者没有座位，只收广播。
 */

/**
 * 导入核心引擎。
 *
 * 刻意用**相对路径 + .ts 扩展名**而不是包名 `@sanguo/core`：
 *  - 开发直接跑 TS 时，Node 的 typescript-strip 需要真实存在的 .ts 扩展名；
 *  - 生产编译产物由 tsc 的 rewriteRelativeImportExtensions 自动改写成 .js，
 *    于是 dist/ 里是干净的相对导入，**不需要 node_modules 就能运行**。
 */
import {
  DEFAULT_RULES,
  PLAYERS,
  PLAYER_KEYS,
  TURN_ORDER,
  applyMove,
  createInitialState,
  isInCheck,
  legalMoves,
  legalMovesFrom,
  parseId,
  resign,
  summarize,
  type GameState,
  type Move,
  type PlayerKey,
  type RuleConfig,
  type Square,
} from '../../../packages/core/src/index.ts';

// ---------------------------------------------------------------------------
// 消息协议
// ---------------------------------------------------------------------------

export type SeatIndex = 0 | 1 | 2;

/** 座位 0/1/2 固定对应 魏/蜀/吴（与回合顺序一致，避免任何映射歧义） */
export const SEAT_TO_PLAYER: Readonly<Record<SeatIndex, PlayerKey>> = {
  0: 'wei',
  1: 'shu',
  2: 'wu',
};

export interface PublicPlayer {
  readonly clientId: string;
  readonly nickname: string;
  /** null = 观战者 */
  readonly seat: SeatIndex | null;
  readonly online: boolean;
  /** 只是否已就座（未就座 = 在等待区） */
  readonly ready: boolean;
}

export interface RoomSnapshot {
  readonly code: string;
  readonly status: RoomStatus;
  readonly players: readonly PublicPlayer[];
  readonly spectatorCount: number;
  readonly game: GameState | null;
  /** 每个座位对应的势力（固定映射，前端可直接用） */
  readonly seatPlayers: Readonly<Record<SeatIndex, PlayerKey>>;
  /** 房间每次变更都 +1，客户端凭它做乐观更新与冲突重同步 */
  readonly version: number;
  /** 当前正被将军的势力（由引擎判定，前端直接用，避免重复实现规则） */
  readonly checkedPlayers: readonly PlayerKey[];
  /** 每家合法的走法总数（用于「无棋可走」提示与棋力显示） */
  readonly legalMoveCounts: Readonly<Record<PlayerKey, number>>;
}

export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface LegalMovesPayload {
  readonly from: string;
  readonly moves: readonly { to: Square; capture: boolean }[];
}

export type ClientMsg =
  | { readonly type: 'join'; readonly nickname: string; readonly token?: string }
  | { readonly type: 'takeSeat'; readonly seat: SeatIndex }
  | { readonly type: 'leaveSeat' }
  | { readonly type: 'requestStart' }
  | { readonly type: 'move'; readonly from: string; readonly to: string; readonly version: number }
  | { readonly type: 'resign' }
  | { readonly type: 'requestLegalMoves'; readonly from: string }
  | { readonly type: 'chat'; readonly text: string }
  | { readonly type: 'ping' };

/**
 * 恢复用的内部消息（只由服务端在启动/首次进房时投递，不来自网络）。
 *
 * 账号系统上线后，对局与落座都会落盘；服务重启或房间被回收后再进来时，
 * 用它在**任何人加入之前**把房间恢复到原来的样子。
 */
export interface RestoreMsg {
  readonly type: 'restore';
  /** 序列化后的 GameState（null = 还没开局） */
  readonly game: GameState | null;
  readonly status: RoomStatus;
  readonly version: number;
  /** 成员：memberId（= 账号 id 字符串）→ { nickname, seat } */
  readonly members: readonly {
    readonly memberId: string;
    readonly nickname: string;
    readonly seat: SeatIndex | null;
  }[];
}

export type ReplyMsg =
  | { readonly type: 'welcome'; readonly clientId: string; readonly token: string; readonly snapshot: RoomSnapshot }
  | { readonly type: 'error'; readonly message: string; readonly code?: string }
  | { readonly type: 'pong' }
  | { readonly type: 'legalMoves'; readonly payload: LegalMovesPayload }
  | { readonly type: 'chat'; readonly from: string; readonly text: string; readonly seat: SeatIndex | null };

export type BroadcastMsg =
  | { readonly type: 'snapshot'; readonly snapshot: RoomSnapshot }
  | { readonly type: 'events'; readonly events: readonly unknown[] }
  | { readonly type: 'chat'; readonly from: string; readonly text: string; readonly seat: SeatIndex | null };

/** 房间对外发出的消息 */
export interface Outbound {
  /** 定向回复（只发给触发者） */
  readonly replies: readonly ReplyMsg[];
  /** 广播（发给房间内所有人） */
  readonly broadcasts: readonly BroadcastMsg[];
}

// ---------------------------------------------------------------------------
// 内部结构
// ---------------------------------------------------------------------------

interface Member {
  readonly clientId: string;
  readonly token: string;
  nickname: string;
  seat: SeatIndex | null;
  online: boolean;
  /** 断线时间戳（用于超时踢人 / 判负），null = 在线 */
  disconnectedAt: number | null;
  /** 重新连接前是否已就座（保留座位用） */
  readonly joinedAt: number;
}

export interface RoomOptions {
  readonly code: string;
  readonly rules?: RuleConfig;
  /** 断线多久后自动判负（毫秒），0 = 不自动判 */
  readonly disconnectForfeitMs?: number;
  /** 现在时刻的取值函数（测试可注入） */
  readonly now?: () => number;
}

export const MAX_SEATS = 3;

export interface RoomChannel {
  readonly code: string;
  /** 处理一条客户端消息，返回需要发出的消息 */
  /** 处理一条消息；clientId 为 null 只应出现在内部 restore 消息上 */
  handle(clientId: string | null, msg: ClientMsg | RestoreMsg): Outbound;
  /** 连接建立（还没 join 时也会调用，用于登记在线状态） */
  connect(clientId: string): Outbound;
  /** 连接断开 */
  disconnect(clientId: string): Outbound;
  /** 当前快照（测试与持久化用） */
  snapshot(): RoomSnapshot;
  /** 是否空房（可以回收） */
  isEmpty(): boolean;
  /** 是否已经开过局（不允许新人就座） */
  started(): boolean;
}

const ok = (...replies: ReplyMsg[]): Outbound => ({ replies, broadcasts: [] });

function err(message: string, code?: string): Outbound {
  return { replies: [{ type: 'error', message, ...(code ? { code } : {}) }], broadcasts: [] };
}

/** 短房间码：去掉容易混淆的 0/O/1/I */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomRoomCode(len = 4, rng: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)]!;
  }
  return out;
}

export function randomToken(bytes = 16, rng: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < bytes; i++) out += Math.floor(rng() * 256).toString(16).padStart(2, '0');
  return out;
}

export function makeClientId(rng: () => number = Math.random): string {
  return `c_${randomToken(8, rng)}`;
}

// ---------------------------------------------------------------------------
// 房间实现
// ---------------------------------------------------------------------------

export function createRoom(opts: RoomOptions): RoomChannel {
  const code = opts.code;
  const rules = opts.rules ?? DEFAULT_RULES;
  const now = opts.now ?? (() => Date.now());
  const members = new Map<string, Member>();
  /** 已就座但尚未开局的座位占用情况 */
  const seats: (string | null)[] = [null, null, null];

  let status: RoomStatus = 'lobby';
  let game: GameState | null = null;
  let version = 0;
  let started = false;

  function bump(): void {
    version += 1;
  }

  function publicPlayers(): PublicPlayer[] {
    return [...members.values()]
      .sort((a, b) => {
        const sa = a.seat ?? 9;
        const sb = b.seat ?? 9;
        if (sa !== sb) return sa - sb;
        return a.joinedAt - b.joinedAt;
      })
      .map((m) => ({
        clientId: m.clientId,
        nickname: m.nickname,
        seat: m.seat,
        online: m.online,
        ready: m.seat !== null,
      }));
  }

  function snapshot(): RoomSnapshot {
    const checked: PlayerKey[] = [];
    const counts = { wei: 0, shu: 0, wu: 0 } as Record<PlayerKey, number>;
    if (game) {
      for (const k of PLAYER_KEYS) {
        if (game.status[k] !== 'playing') continue;
        if (isInCheck(game, k)) checked.push(k);
        counts[k] = game.turn === k ? legalMoves(game, k).length : 0;
      }
    }
    return {
      code,
      status,
      players: publicPlayers(),
      spectatorCount: [...members.values()].filter((m) => m.seat === null).length,
      game,
      seatPlayers: SEAT_TO_PLAYER,
      version,
      checkedPlayers: checked,
      legalMoveCounts: counts,
    };
  }

  function broadcastSnapshot(): Outbound {
    bump();
    return { replies: [], broadcasts: [{ type: 'snapshot', snapshot: snapshot() }] };
  }

  function nickOf(clientId: string | null): string {
    if (!clientId) return '系统';
    return members.get(clientId)?.nickname ?? '匿名';
  }

  function seatOf(clientId: string | null): SeatIndex | null {
    if (!clientId) return null;
    return members.get(clientId)?.seat ?? null;
  }

  /** 找第一个空座位 */
  function firstFreeSeat(): SeatIndex | null {
    for (let i = 0; i < MAX_SEATS; i++) if (seats[i] === null) return i as SeatIndex;
    return null;
  }

  function allSeatsTaken(): boolean {
    return seats.every((s) => s !== null);
  }

  function startGame(): Outbound {
    game = createInitialState(rules);
    status = 'playing';
    started = true;
    bump();
    return {
      replies: [],
      broadcasts: [
        { type: 'events', events: [{ type: 'gameStarted' }] },
        { type: 'snapshot', snapshot: snapshot() },
      ],
    };
  }

  function requireGame(): GameState | null {
    return game;
  }

  function handle(clientId: string | null, msg: ClientMsg | RestoreMsg): Outbound {
    switch (msg.type) {
      // -------------------------------------------------------------------
      // 恢复（内部消息，不来自网络）：把落盘的对局与落座装回房间
      // -------------------------------------------------------------------
      case 'restore': {
        for (const m of msg.members) {
          members.set(m.memberId, {
            clientId: m.memberId,
            token: randomToken(),
            nickname: m.nickname,
            seat: m.seat,
            online: false, // 恢复时都算离线，等真人连上来再置为在线
            disconnectedAt: null,
            joinedAt: Date.now(),
          });
        }
        if (msg.game) {
          game = msg.game;
          status = msg.status;
          started = true;
          version = msg.version;
        }
        return { replies: [], broadcasts: [] };
      }
      // -------------------------------------------------------------------
      case 'join': {
        const nickname = (msg.nickname ?? '').trim().slice(0, 16) || '无名';
        // 凭 token 重连
        if (msg.token) {
          const existing = [...members.values()].find((m) => m.token === msg.token);
          if (existing) {
            existing.online = true;
            existing.disconnectedAt = null;
            existing.nickname = nickname;
            bump();
            return {
              replies: [
                {
                  type: 'welcome',
                  clientId: existing.clientId,
                  token: existing.token,
                  snapshot: snapshot(),
                },
              ],
              broadcasts: [{ type: 'snapshot', snapshot: snapshot() }],
            };
          }
        }
        if (!clientId) return err('缺少客户端标识', 'noClientId');
        const existingById = members.get(clientId);
        if (existingById) {
          if (existingById.online) return err('该连接已加入房间', 'alreadyJoined');
          existingById.online = true;
          existingById.disconnectedAt = null;
          existingById.nickname = nickname;
          bump();
          return {
            replies: [
              {
                type: 'welcome',
                clientId: existingById.clientId,
                token: existingById.token,
                snapshot: snapshot(),
              },
            ],
            broadcasts: [{ type: 'snapshot', snapshot: snapshot() }],
          };
        }

        const member: Member = {
          clientId,
          token: randomToken(),
          nickname,
          seat: null,
          online: true,
          disconnectedAt: null,
          joinedAt: now(),
        };
        members.set(clientId, member);
        // 刻意**不自动占座**：进房只是「进来看看」，势力由玩家自己在
        // 三个未被占用的势力里挑（用户要求：不再固定按顺序当魏蜀吴）。
        // 开局条件仍然是「三个座位都有人」，由 takeSeat 触发。
        bump();
        return {
          replies: [
            { type: 'welcome', clientId: member.clientId, token: member.token, snapshot: snapshot() },
          ],
          broadcasts: [{ type: 'snapshot', snapshot: snapshot() }],
        };
      }

      // -------------------------------------------------------------------
      case 'takeSeat': {
        const m = clientId ? members.get(clientId) : undefined;
        if (!m) return err('请先加入房间', 'notJoined');
        if (started) return err('对局已开始，不能再换座位', 'alreadyStarted');
        if (msg.seat < 0 || msg.seat >= MAX_SEATS) return err('座位号无效', 'badSeat');
        if (seats[msg.seat] !== null && seats[msg.seat] !== clientId) {
          return err('该座位已被占用', 'seatTaken');
        }
        // 释放旧座位
        if (m.seat !== null) seats[m.seat] = null;
        m.seat = msg.seat;
        seats[msg.seat] = clientId;
        const out = broadcastSnapshot();
        if (allSeatsTaken()) {
          const s = startGame();
          return { replies: [], broadcasts: [...out.broadcasts, ...s.broadcasts] };
        }
        return out;
      }

      case 'leaveSeat': {
        const m = clientId ? members.get(clientId) : undefined;
        if (!m) return err('请先加入房间', 'notJoined');
        if (started) return err('对局已开始，不能离座（可以认输）', 'alreadyStarted');
        if (m.seat !== null) {
          seats[m.seat] = null;
          m.seat = null;
        }
        return broadcastSnapshot();
      }

      // -------------------------------------------------------------------
      case 'requestStart': {
        if (started) return err('对局已开始', 'alreadyStarted');
        if (!allSeatsTaken()) {
          return err(`还差 ${seats.filter((s) => s === null).length} 位玩家`, 'notEnoughPlayers');
        }
        return startGame();
      }

      // -------------------------------------------------------------------
      case 'move': {
        const m = clientId ? members.get(clientId) : undefined;
        if (!m) return err('请先加入房间', 'notJoined');
        if (m.seat === null) return err('观战者不能走子', 'notSeated');
        const g = requireGame();
        if (!g) return err('对局尚未开始', 'notStarted');
        if (status !== 'playing') return err('对局已结束', 'finished');
        if (msg.version !== version) {
          // 版本冲突：让客户端重新同步，而不是直接静默失败
          return {
            replies: [
              { type: 'error', message: '房间状态已更新，请重试', code: 'staleVersion' },
              { type: 'welcome', clientId: m.clientId, token: m.token, snapshot: snapshot() },
            ],
            broadcasts: [],
          };
        }
        const myPlayer = SEAT_TO_PLAYER[m.seat];
        if (g.turn !== myPlayer) {
          return err(`现在轮到 ${PLAYERS[g.turn].name}`, 'notYourTurn');
        }
        const move: Move = { from: parseId(msg.from), to: parseId(msg.to) };
        const r = applyMove(g, move);
        if (!r.ok) return err(r.error, 'illegalMove');
        game = r.state;
        if (game.phase === 'finished') status = 'finished';
        bump();
        return {
          replies: [],
          broadcasts: [
            { type: 'events', events: r.events },
            { type: 'snapshot', snapshot: snapshot() },
          ],
        };
      }

      case 'resign': {
        const m = clientId ? members.get(clientId) : undefined;
        if (!m) return err('请先加入房间', 'notJoined');
        if (m.seat === null) return err('观战者不能认输', 'notSeated');
        const g = requireGame();
        if (!g || status !== 'playing') return err('对局未在进行中', 'notPlaying');
        const r = resign(g, SEAT_TO_PLAYER[m.seat]);
        if (!r.ok) return err(r.error, 'resignFailed');
        game = r.state;
        if (game.phase === 'finished') status = 'finished';
        bump();
        return {
          replies: [],
          broadcasts: [
            { type: 'events', events: r.events },
            { type: 'snapshot', snapshot: snapshot() },
          ],
        };
      }

      // -------------------------------------------------------------------
      case 'requestLegalMoves': {
        const g = requireGame();
        if (!g) return ok({ type: 'legalMoves', payload: { from: msg.from, moves: [] } });
        const ms = legalMovesFrom(g, msg.from);
        return ok({
          type: 'legalMoves',
          payload: {
            from: msg.from,
            moves: ms.map((m) => ({ to: m.to, capture: m.captured !== undefined })),
          },
        });
      }

      case 'chat': {
        const text = (msg.text ?? '').trim().slice(0, 200);
        if (!text) return ok();
        return {
          replies: [],
          broadcasts: [{ type: 'chat', from: nickOf(clientId), text, seat: seatOf(clientId) }],
        };
      }

      case 'ping':
        return ok({ type: 'pong' });

      default:
        return err('未知消息类型', 'unknownType');
    }
  }

  function connect(clientId: string): Outbound {
    const m = members.get(clientId);
    if (!m) return { replies: [], broadcasts: [] };
    const wasOffline = !m.online;
    m.online = true;
    m.disconnectedAt = null;
    if (!wasOffline) return { replies: [], broadcasts: [] };
    return broadcastSnapshot();
  }

  function disconnect(clientId: string): Outbound {
    const m = members.get(clientId);
    if (!m) return { replies: [], broadcasts: [] };
    m.online = false;
    m.disconnectedAt = now();
    return broadcastSnapshot();
  }

  return {
    code,
    handle,
    connect,
    disconnect,
    snapshot,
    isEmpty: () => members.size === 0,
    started: () => started,
  };}

// ---------------------------------------------------------------------------
// 房间管理器
// ---------------------------------------------------------------------------

export interface RoomManager {
  readonly rooms: ReadonlyMap<string, RoomChannel>;
  create(options?: Partial<RoomOptions>): RoomChannel;
  get(code: string): RoomChannel | undefined;
  /** 回收空房（定期调用） */
  gc(): readonly string[];
}

export function createRoomManager(
  defaultOptions: Partial<RoomOptions> = {},
): RoomManager {
  const rooms = new Map<string, RoomChannel>();

  function create(options: Partial<RoomOptions> = {}): RoomChannel {
    let code = options.code ?? randomRoomCode();
    // 避免撞码（4 位短码空间 32^4 = 100 万，实际够用）
    let guard = 0;
    while (rooms.has(code) && guard++ < 100) code = randomRoomCode();
    const room = createRoom({ ...defaultOptions, ...options, code });
    rooms.set(code, room);
    return room;
  }

  return {
    rooms,
    create,
    get: (code) => rooms.get(code.toUpperCase()),
    gc: () => {
      const removed: string[] = [];
      for (const [code, room] of rooms) {
        if (room.isEmpty()) {
          rooms.delete(code);
          removed.push(code);
        }
      }
      return removed;
    },
  };
}

// ---------------------------------------------------------------------------
// 便捷工具（前端也会用到）
// ---------------------------------------------------------------------------

/** 某家现在是否可动（用于 UI 灰化） */
export function isMyTurn(game: GameState | null, player: PlayerKey): boolean {
  return !!game && game.phase === 'playing' && game.turn === player;
}

export function moveCount(game: GameState | null): number {
  return game ? legalMoves(game).length : 0;
}

export function summaryOf(game: GameState | null): ReturnType<typeof summarize> | null {
  return game ? summarize(game) : null;
}

export { TURN_ORDER, PLAYER_KEYS, SEAT_TO_PLAYER as SEATS };
