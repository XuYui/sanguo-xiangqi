/**
 * 账号与对局持久化所需的存储层。
 *
 * 这里只定义**接口**，具体实现可以是 SQLite（生产）或内存（测试）。
 * 房间引擎只依赖这些接口，方便单测时替换。
 */

/** 一个账号对外可见的信息（绝不包含密码哈希） */
export interface Account {
  readonly id: number;
  readonly username: string;
  readonly nickname: string;
  /** 创建时间（毫秒时间戳） */
  readonly createdAt: number;
}

/** 账号 + 密码哈希（仅存储层内部使用） */
export interface AccountWithSecret extends Account {
  readonly passwordHash: string;
  readonly passwordSalt: string;
}

/** 会话（登录令牌 → 账号） */
export interface Session {
  readonly token: string;
  readonly accountId: number;
  readonly createdAt: number;
  /** 过期时间（毫秒时间戳） */
  readonly expiresAt: number;
}

/** 某个房间里的落座记录（跨刷新/重启保留） */
export interface PersistedSeat {
  readonly code: string;
  readonly accountId: number;
  /** 0/1/2；null = 已加入但未落座（观战） */
  readonly seat: number | null;
  readonly nickname: string;
  readonly joinedAt: number;
}

/** 一局被持久化的对局 */
export interface PersistedGame {
  readonly code: string;
  /** 房间状态：lobby / playing / finished */
  readonly status: string;
  /** 序列化后的 GameState（引擎的纯数据快照） */
  readonly gameJson: string;
  /** 房间版本号，用于客户端乐观更新 */
  readonly version: number;
  readonly updatedAt: number;
}

/** 存储接口：SQLite 与内存实现都遵守 */
export interface AuthStore {
  // --- 账号 ---
  createAccount(username: string, nickname: string, passwordHash: string, passwordSalt: string): AccountWithSecret | null;
  findAccountByName(username: string): AccountWithSecret | null;
  findAccountById(id: number): AccountWithSecret | null;

  // --- 会话 ---
  createSession(token: string, accountId: number, createdAt: number, expiresAt: number): void;
  findSession(token: string): Session | null;
  deleteSession(token: string): void;
  /** 清理过期会话，返回清理条数 */
  purgeExpiredSessions(now: number): number;

  // --- 房间落座 ---
  upsertSeat(seat: PersistedSeat): void;
  seatsOfRoom(code: string): readonly PersistedSeat[];
  roomsOfAccount(accountId: number): readonly PersistedSeat[];
  deleteSeat(code: string, accountId: number): void;

  // --- 对局 ---
  saveGame(game: PersistedGame): void;
  loadGame(code: string): PersistedGame | null;
  deleteGame(code: string): void;
  /** 列出所有未结束的对局（用于服务重启后恢复） */
  listLiveGames(): readonly PersistedGame[];

  close(): void;
}

/** 账号名校验：3~16 位字母数字下划线 */
export const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

/** 密码最短长度 */
export const MIN_PASSWORD_LENGTH = 6;
