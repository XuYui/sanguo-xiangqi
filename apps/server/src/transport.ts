/**
 * Socket.IO 传输层
 *
 * 职责边界很清楚：只做「连接 ↔ 房间消息」的搬运，不含任何棋规或房间规则。
 *  - 每个 socket 绑定一个 clientId（首次连接即生成，重连时由客户端带来 token 认领旧身份）；
 *  - 客户端发 `msg`，服务端把房间产出的 replies 回给本人、broadcasts 发给房间频道；
 *  - 频道名 `room:<CODE>`，观战者与玩家在同一个频道。
 *
 * 前端协议（与 room.ts 的 ClientMsg / ReplyMsg / BroadcastMsg 一一对应）：
 *   socket.emit('msg', clientMsg)
 *   socket.on('reply', replyMsg)       // 定向回复
 *   socket.on('broadcast', broadcastMsg) // 房间广播
 *   socket.emit('joinRoom', { code })  // 进频道（必须先发，才能收到 broadcast）
 */

import type { Server as HttpServer } from 'node:http';

import { Server as IOServer, type Socket } from 'socket.io';

import type { AuthService } from './auth.ts';
import {
  MAX_SEATS,
  createRoomManager,
  makeClientId,
  randomRoomCode,
  type BroadcastMsg,
  type ClientMsg,
  type ReplyMsg,
  type RoomChannel,
  type RoomManager,
} from './room.ts';
import type { AuthStore } from './store.ts';

export interface TransportOptions {
  /** 允许的跨域来源；同源部署时留空即可 */
  readonly corsOrigins?: readonly string[];
  /** 空房回收间隔（毫秒），0 = 不自动回收 */
  readonly gcIntervalMs?: number;
  /** 账号服务；不传则退化为「匿名连接」（单测用） */
  readonly auth?: AuthService;
  /** 持久化存储；不传则不落盘（单测用） */
  readonly store?: AuthStore;
}

export interface Transport {
  readonly io: IOServer;
  readonly manager: RoomManager;
  close(): Promise<void>;
}

export function attachTransport(httpServer: HttpServer, options: TransportOptions = {}): Transport {
  const io = new IOServer(httpServer, {
    path: '/socket.io',
    // 需要托管 /socket.io/socket.io.js（前端直接 <script> 引入，避免依赖外网 CDN）
    serveClient: true,
    cors: options.corsOrigins?.length ? { origin: [...options.corsOrigins] } : undefined,
    transports: ['websocket', 'polling'],
  });

  const { auth, store } = options;

  /**
   * 握手阶段解析登录令牌。
   *
   * 客户端在 `io(url, { auth: { token } })` 里带上会话令牌。
   * 令牌无效也**不拒绝连接**——匿名用户照样可以观战（这是产品要求：
   * 没账号的人也能看棋，只是不能坐下参战）。
   */
  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    const account = auth?.verify(typeof token === 'string' ? token : null) ?? null;
    if (account) {
      socket.data.account = { id: account.id, username: account.username, nickname: account.nickname };
      socket.data.memberId = String(account.id);
    }
    next();
  });

  const manager = createRoomManager();

  /** socket.id -> { clientId, code } */
  const session = new Map<string, { clientId: string; code: string | null }>();

  function channelOf(code: string | null): RoomChannel | undefined {
    return code ? manager.get(code) : undefined;
  }

  /** 把房间产出投递出去：定向回复给本人，广播给房间频道 */
  function dispatch(socket: Socket, code: string, out: { replies: readonly ReplyMsg[]; broadcasts: readonly BroadcastMsg[] }): void {
    for (const r of out.replies) socket.emit('reply', r);
    for (const b of out.broadcasts) io.to(`room:${code}`).emit('broadcast', b);
    persistRoom(code, out.broadcasts);
  }

  /**
   * 把房间状态落盘：落座记录 + 对局快照。
   *
   * 从 broadcasts 里取最新的 snapshot 就够了——房间每次变更都会广播快照，
   * 所以这里不需要侵入 room.ts 的业务逻辑。
   */
  function persistRoom(code: string, broadcasts: readonly BroadcastMsg[]): void {
    if (!store) return;
    let snap: BroadcastMsg & { type: 'snapshot' } | null = null;
    for (const b of broadcasts) if (b.type === 'snapshot') snap = b as never;
    if (!snap) return;
    const snapshot = (snap as { snapshot: import('./room.ts').RoomSnapshot }).snapshot;

    for (const p of snapshot.players) {
      // 只有账号成员才落盘（匿名的 clientId 不是数字，跳过）
      const accountId = Number(p.clientId);
      if (!Number.isFinite(accountId)) continue;
      store.upsertSeat({
        code,
        accountId,
        seat: p.seat,
        nickname: p.nickname,
        joinedAt: Date.now(),
      });
    }
    if (snapshot.game) {
      store.saveGame({
        code,
        status: snapshot.status,
        gameJson: JSON.stringify(snapshot.game),
        version: snapshot.version,
        updatedAt: Date.now(),
      });
    } else if (snapshot.status === 'finished') {
      store.deleteGame(code);
    }
  }

  /**
   * 从落盘状态恢复房间（服务重启、或房间被回收后再次进入时）。
   *
   * 必须在**任何人加入之前**调用，否则会把已加入的成员冲掉。
   */
  function restoreRoom(code: string, room: RoomChannel): void {
    if (!store) return;
    const seats = store.seatsOfRoom(code);
    const game = store.loadGame(code);
    if (seats.length === 0 && !game) return;
    let parsedGame: import('./room.ts').RoomSnapshot['game'] = null;
    if (game) {
      try {
        parsedGame = JSON.parse(game.gameJson) as never;
      } catch {
        parsedGame = null;
      }
    }
    const out = room.handle(null, {
      type: 'restore',
      game: parsedGame,
      status: (game?.status ?? 'lobby') as 'lobby' | 'playing' | 'finished',
      version: game?.version ?? 0,
      members: seats.map((s) => ({
        memberId: String(s.accountId),
        nickname: s.nickname,
        seat: (s.seat === null ? null : s.seat) as 0 | 1 | 2 | null,
      })),
    });
    // 恢复本身不产生广播
    void out;
    console.log(`[sanguo] 已恢复房间 ${code}：${seats.length} 名成员，对局=${game ? game.status : '无'}`);
  }

  io.on('connection', (socket) => {
    /**
     * 成员身份。
     *
     * 已登录用户用**账号 id** 作为房间成员标识——跨刷新、跨设备、跨服务重启都稳定，
     * 这正是「刷新后回到原座位继续下」的基础。
     * 未登录访客退化为一次性连接 id（只能观战，不能落座）。
     */
    const account = socket.data.account as
      | { id: number; username: string; nickname: string }
      | undefined;
    const clientId = account ? String(account.id) : makeClientId();
    session.set(socket.id, { clientId, code: null });

    socket.emit('ready', {
      clientId,
      maxSeats: MAX_SEATS,
      randomCode: randomRoomCode(),
      account: account ?? null,
      /** 未登录时为 true：可观战但不能坐下参战 */
      guest: !account,
      defaultNickname: account?.nickname ?? null,
    });

    /** 进入房间频道 */
    socket.on('joinRoom', (payload: { code?: string } | undefined, ack?: (r: unknown) => void) => {
      const code = (payload?.code ?? '').toUpperCase().trim();
      if (!/^[A-Z0-9]{3,8}$/.test(code)) {
        ack?.({ ok: false, error: '房间码格式不对（3~8 位字母数字）' });
        return;
      }
      const existing = channelOf(code);
      const room = existing ?? manager.create({ code });
      // 房间是新建的（服务重启后，或已被回收）→ 先把落盘状态装回去，
      // 必须在任何人加入之前完成，否则会冲掉已加入的成员
      if (!existing) restoreRoom(code, room);

      const sess = session.get(socket.id);
      if (sess) sess.code = code;
      void socket.join(`room:${code}`);
      ack?.({ ok: true, code, created: !existing });

      // 若该连接此前已加入别的房间，先让它从那边退出（避免一个人同时挂在两个房间）
      for (const [otherCode, other] of manager.rooms) {
        if (otherCode === code) continue;
        if (other.snapshot().players.some((p) => p.clientId === clientId)) {
          socket.leave(`room:${otherCode}`);
          const out = other.disconnect(clientId);
          for (const b of out.broadcasts) io.to(`room:${otherCode}`).emit('broadcast', b);
        }
      }

      // 顺序很重要：**先**把身份（clientId）发给客户端，再投递房间快照。
      // 反过来的话，客户端处理快照时还不知道自己是谁，
      // 会导致 myPlayer 为 null（棋盘点不动、横幅显示「等待 X 走子」）。
      socket.emit('joined', { code, clientId, account: account ?? null });
      dispatch(socket, code, room.connect(clientId));
    });

    /** 房间消息 */
    socket.on('msg', (msg: ClientMsg, ack?: (r: unknown) => void) => {
      const sess = session.get(socket.id);
      const code = sess?.code ?? null;
      if (!code) {
        socket.emit('reply', {
          type: 'error',
          message: '请先加入房间',
          code: 'noRoom',
        } satisfies ReplyMsg);
        ack?.({ ok: false, error: 'noRoom' });
        return;
      }
      const room = channelOf(code);
      if (!room) {
        socket.emit('reply', {
          type: 'error',
          message: '房间不存在',
          code: 'noRoom',
        } satisfies ReplyMsg);
        ack?.({ ok: false, error: 'noRoom' });
        return;
      }
      // 未登录访客只允许观战相关消息：落座 / 走子 / 认输一律拒绝
      if (!account && (msg.type === 'takeSeat' || msg.type === 'move' || msg.type === 'resign')) {
        socket.emit('reply', {
          type: 'error',
          message: '请先登录账号才能参战（当前为观战模式）',
          code: 'loginRequired',
        } satisfies ReplyMsg);
        ack?.({ ok: false, error: 'loginRequired' });
        return;
      }
      const out = room.handle(clientId, msg);
      dispatch(socket, code, out);
      const error = out.replies.find((reply) => reply.type === 'error');
      ack?.(error ? { ok: false, error: error.message, code: error.code } : { ok: true });
    });

    socket.on('disconnect', () => {
      const sess = session.get(socket.id);
      session.delete(socket.id);
      if (!sess?.code) return;
      const room = channelOf(sess.code);
      if (!room) return;
      const out = room.disconnect(sess.clientId);
      for (const b of out.broadcasts) io.to(`room:${sess.code}`).emit('broadcast', b);
      // 房间若空了，交给 gc 定时回收
    });
  });

  let gcTimer: NodeJS.Timeout | null = null;
  const gcMs = options.gcIntervalMs ?? 60_000;
  if (gcMs > 0) {
    gcTimer = setInterval(() => {
      manager.gc();
    }, gcMs);
    gcTimer.unref?.();
  }

  return {
    io,
    manager,
    close: async () => {
      if (gcTimer) clearInterval(gcTimer);
      await io.close();
    },
  };
}
