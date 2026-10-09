/**
 * 与服务器的 Socket.IO 通道
 *
 * 协议（与服务端 apps/server/src/transport.ts 对应）：
 *   连接建立  -> 收到 'ready'      { clientId, maxSeats, randomCode }
 *   joinRoom  -> 'joined'          { code, clientId }
 *   msg       -> 定向 'reply'      / 房间 'broadcast'
 *
 * 身份模型（账号系统）：
 *   房间成员 id = **账号 id**（服务端以字符串形式下发），跨刷新/跨设备/跨重启都稳定。
 *   未登录访客拿到的是一次性连接 id，只能观战。
 *   连接时通过 Socket.IO 的 auth 字段带上会话令牌，服务端在握手里解析。
 */

const TOKEN_PREFIX = 'sanguo.token.';

/**
 * 账号会话令牌的存储键。
 *
 * 登录一次记住 90 天（与服务端会话同效期），刷新/重开浏览器免登录。
 * 这是「刷新后回到原座位」的根本保证：成员身份 = 账号，账号由令牌确定，
 * 与每次都会变化的 socket 连接 id 无关。
 *
 * 安全取舍：令牌存 localStorage，对 XSS 无免疫力；但本页面不渲染任何
 * 用户输入的 HTML（聊天用 textContent 纯文本），当前规模下可接受。
 * 若要更强可改为 HttpOnly Cookie + CSRF 保护。
 */
const SESSION_KEY = 'sanguo.session';

export function loadSessionToken() {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function saveSessionToken(token) {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* localStorage 不可用时忽略（仅当次会话有效） */
  }
}

/** 向账号接口发一个 JSON POST */
async function authPost(path, payload) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, ...body };
}

/** 账号相关 HTTP 调用（注册 / 登录 / 登出 / 校验会话） */
export const account = {
  /** 当前令牌（内存中，与服务端会话一致） */
  token: loadSessionToken(),

  get loggedIn() {
    return !!this.token;
  },

  /** 校验会话是否仍有效：有效返回账号对象，失效返回 null 并清理本地令牌 */
  async me() {
    if (!this.token) return null;
    try {
      const r = await fetch('/api/auth/me', {
        headers: { authorization: `Bearer ${this.token}` },
      });
      if (!r.ok) {
        saveSessionToken(null);
        this.token = null;
        return null;
      }
      const body = await r.json();
      return body.account ?? null;
    } catch {
      return null; // 网络异常不当作未登录，保留令牌
    }
  },

  async register(username, password, nickname) {
    const body = await authPost('/api/auth/register', { username, password, nickname });
    if (body.ok && body.token) {
      saveSessionToken(body.token);
      this.token = body.token;
    }
    return body;
  },

  async login(username, password) {
    const body = await authPost('/api/auth/login', { username, password });
    if (body.ok && body.token) {
      saveSessionToken(body.token);
      this.token = body.token;
    }
    return body;
  },

  async logout() {
    const t = this.token;
    saveSessionToken(null);
    this.token = null;
    if (!t) return;
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${t}` },
      });
    } catch {
      /* 本地已登出即可；服务端会话到期会自动清理 */
    }
  },
};

/**
 * 「我是谁」的缓存键（按房间码区分）。
 *
 * 为什么需要：客户端原本只在收到 `joined` 事件时才知道自己的 clientId，
 * 而 `welcome` 回复与房间快照可能**先于** `joined` 到达（polling 传输下尤其明显，
 * 同一批消息按序返回）。那样第一帧推导身份时 clientId 还是 null，
 * 会导致 myPlayer = null → 棋盘点击被静默忽略、横幅显示「等待 X 走子」。
 *
 * 存一份 clientId，刷新/重连后可以**立刻**认出自己，不再依赖消息到达顺序。
 * 使用前必须用快照里的 players 校验（见 app.js 的 deriveIdentity），
 * 因为房间可能已被回收重建。
 */
const CLIENT_KEY_PREFIX = 'sanguo.clientId.';

export class Channel {
  constructor() {
    /** @type {import('socket.io-client').Socket | null} */
    this.socket = null;
    /** @type {((msg:any)=>void)[]} */
    this.replyHandlers = [];
    /** @type {((msg:any)=>void)[]} */
    this.broadcastHandlers = [];
    /** @type {((status:string)=>void)[]} */
    this.statusHandlers = [];
    /** @type {((clientId:string)=>void)[]} 拿到/切换身份时回调（用于立即推导 myPlayer） */
    this.clientIdHandlers = [];
    this.reconnectHandlers = [];
    this.code = null;
    this.clientId = null;
    this.token = null;
    this.serverInfo = null;
  }

  onReply(fn) {
    this.replyHandlers.push(fn);
  }

  onBroadcast(fn) {
    this.broadcastHandlers.push(fn);
  }

  onStatus(fn) {
    this.statusHandlers.push(fn);
  }

  /** 注册身份回调，并**立即**用当前已知身份触发一次（避免错过早到的事件） */
  onClientId(fn) {
    this.clientIdHandlers.push(fn);
    if (this.clientId) fn(this.clientId);
  }

  onReconnect(fn) {
    this.reconnectHandlers.push(fn);
  }

  /**
   * 本次 socket.io 连接的标识（服务端 `ready` 事件给出）。
   *
   * ⚠️ 这**不是**房间成员身份，甚至不是稳定值——**每次连接都会变**。
   * 绝不能把它当成「我是谁」存下来：一旦写进 localStorage，
   * 刷新后客户端就会拿一个已经失效的 id 去比对快照，永远认不出自己
   * （这正是「刷新后点不动棋子」的根因）。
   *
   * 真正的成员身份只有两个来源，都来自服务端：
   *   1. `welcome` 回复里的 clientId（房间成员的权威 id）；
   *   2. `joined` 事件里的 clientId（进频道时服务端回的成员 id）。
   * 见 setMemberId。
   */
  connectionClientId = null;

  #notifyClientId(id) {
    for (const fn of this.clientIdHandlers) fn(id);
  }

  /**
   * 记住/切换**成员身份**（服务端权威 id），并按房间码落盘。
   *
   * 只有成员 id 才允许写进 localStorage——刷新/重连后靠它立刻认出自己。
   * 凭 token 重连时，服务端会在 `welcome` 里回带**原成员 id**，
   * 所以这里也会被纠正回正确的值。
   */
  setMemberId(id) {
    if (!id || id === this.clientId) return;
    this.clientId = id;
    if (this.code) {
      try {
        localStorage.setItem(CLIENT_KEY_PREFIX + this.code, id);
      } catch {
        /* localStorage 不可用时忽略 */
      }
    }
    this.#notifyClientId(id);
  }

  /** 读取某房间上次记住的身份（可能已失效，调用方需校验） */
  rememberedClientId(code) {
    if (!code) return null;
    try {
      return localStorage.getItem(CLIENT_KEY_PREFIX + code) ?? null;
    } catch {
      return null;
    }
  }

  #emitStatus(s) {
    for (const fn of this.statusHandlers) fn(s);
  }

  /** 连接服务器（当前域名经 Cloudflare，固定使用 Socket.IO polling） */
  connect() {
    this.#openSocket();
  }

  /**
   * 用**当前**账号令牌重新建立连接。
   *
   * 为什么不能只 `socket.disconnect(); socket.connect()`：
   * Socket.IO 的 `auth` 只在**创建 socket 时**读取一次，
   * 复用同一个 socket 实例重连仍会带旧的（可能是空的）令牌，
   * 服务端就会继续把它当匿名访客——表现为「明明登录了却选不了势力」。
   * 所以必须销毁旧 socket、用新令牌重建。
   */
  async reconnectWithToken() {
    const roomCode = this.code;
    const connected = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 8000); // 连不上也别卡住调用方
      this.#openSocket();
      this.socket.once('connect', async () => {
        if (!roomCode) {
          clearTimeout(t);
          resolve(null);
          return;
        }
        // 重建 socket 后原来的房间频道已经失效，必须重新 joinRoom。
        const ack = await this.joinRoom(roomCode);
        clearTimeout(t);
        resolve(ack);
      });
    });
    await connected;
  }

  #openSocket() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.socket = window.io({
      transports: ['polling'],
      upgrade: false,
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      timeout: 20_000,
      // 握手时带上会话令牌，服务端据此把连接绑定到账号。
      // 这个字段只在创建时生效——登录/登出后必须走 reconnectWithToken()。
      auth: { token: account.token ?? undefined },
    });
    this.#bindSocket();
  }

  #bindSocket() {
    this.socket.on('connect', () => this.#emitStatus('connected'));
    this.socket.on('disconnect', (reason) => this.#emitStatus(`disconnected:${reason}`));
    this.socket.on('connect_error', (e) => this.#emitStatus(`error:${e.message}`));

    this.socket.on('ready', (info) => {
      this.serverInfo = info;
      // 注意：info.clientId 是**连接**标识（每次连接都变），只记下来备查，
      // 不当作成员身份、也绝不落盘。成员身份见 setMemberId。
      this.connectionClientId = info?.clientId ?? null;
    });
    this.socket.on('joined', (info) => {
      this.code = info.code;
      this.token = localStorage.getItem(TOKEN_PREFIX + this.code) ?? null;
      // 服务端权威的成员身份；赋值后立即通知，这样即使快照已经先到过，
      // app 也能马上重新推导出「我是谁」
      this.setMemberId(info.clientId);
    });
    this.socket.on('reply', (msg) => {
      for (const fn of this.replyHandlers) fn(msg);
    });
    this.socket.on('broadcast', (msg) => {
      for (const fn of this.broadcastHandlers) fn(msg);
    });
    this.socket.io?.on('reconnect', () => {
      for (const fn of this.reconnectHandlers) fn();
    });
  }

  /** 进入房间频道 */
  joinRoom(code) {
    return new Promise((resolve) => {
      this.socket.emit('joinRoom', { code }, (ack) => {
        if (ack?.ok) {
          this.code = ack.code;
          this.token = localStorage.getItem(TOKEN_PREFIX + ack.code) ?? null;
          resolve(ack);
        } else {
          resolve(ack ?? { ok: false, error: '未知错误' });
        }
      });
    });
  }

  send(msg) {
    this.socket?.emit('msg', msg);
  }

  /** 加入房间（带 token 自动重连） */
  hello(nickname) {
    this.send({ type: 'join', nickname, ...(this.token ? { token: this.token } : {}) });
  }

  rememberToken(token) {
    if (!this.code || !token) return;
    localStorage.setItem(TOKEN_PREFIX + this.code, token);
    this.token = token;
  }

  forgetToken() {
    if (!this.code) return;
    localStorage.removeItem(TOKEN_PREFIX + this.code);
    this.token = null;
  }

  /** 清掉当前房间记住的成员身份（登录状态切换时使用） */
  forgetIdentity() {
    if (this.code) {
      try {
        localStorage.removeItem(CLIENT_KEY_PREFIX + this.code);
      } catch {
        /* localStorage 不可用时忽略 */
      }
    }
    this.clientId = null;
  }
}
