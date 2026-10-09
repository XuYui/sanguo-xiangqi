/**
 * SQLite 存储实现（Node 内置 `node:sqlite`，无需第三方依赖）。
 *
 * 选择它的理由：
 *  - 服务器 Node v24.15 自带 node:sqlite（DatabaseSync），免去原生编译；
 *  - 单文件 + WAL 模式，1 GB 内存的小机器上只占几 MB；
 *  - 同步 API，对房间这种低频写入场景最简单可靠。
 *
 * 注意：`node:sqlite` 目前仍标记为 experimental，Node 会在启动时打印警告。
 * 我们显式检查可用性，不可用时报出清晰错误，而不是让服务悄悄挂掉。
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import {
  type Account,
  type AccountWithSecret,
  type AuthStore,
  type PersistedGame,
  type PersistedSeat,
  type Session,
} from './store.ts';

/** 用 createRequire 加载内置模块，避免 ESM 下 require 不存在的问题 */
const requireCjs = createRequire(import.meta.url);

/** node:sqlite 的最小类型（避免依赖 @types 里的实验性声明） */
interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  nickname      TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  password_salt TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

CREATE TABLE IF NOT EXISTS room_members (
  code       TEXT    NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  seat       INTEGER,
  nickname   TEXT    NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (code, account_id)
);
CREATE INDEX IF NOT EXISTS idx_room_members_account ON room_members(account_id);

CREATE TABLE IF NOT EXISTS games (
  code       TEXT    PRIMARY KEY,
  status     TEXT    NOT NULL,
  game_json  TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

function num(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

export class SqliteStore implements AuthStore {
  #db: SqliteDb;

  constructor(file: string) {
    // 确保目录存在（首次部署时 data/ 可能还没建）
    const dir = dirname(file);
    if (dir && dir !== '.' && dir !== '/') mkdirSync(dir, { recursive: true });

    let DatabaseSync: new (path: string) => SqliteDb;
    try {
      ({ DatabaseSync } = requireCjs('node:sqlite') as {
        DatabaseSync: new (path: string) => SqliteDb;
      });
    } catch (e) {
      throw new Error(
        '当前 Node 不支持内置 node:sqlite（需要 Node >= 22.5）。' +
          `请升级 Node，或改用其他存储实现。原始错误：${(e as Error).message}`,
      );
    }
    this.#db = new DatabaseSync(file);
    // WAL：读写并发更好，且异常退出后恢复更可靠
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec(SCHEMA);
  }

  // -------------------------------------------------------------------------
  // 账号
  // -------------------------------------------------------------------------

  createAccount(
    username: string,
    nickname: string,
    passwordHash: string,
    passwordSalt: string,
  ): AccountWithSecret | null {
    try {
      const info = this.#db
        .prepare(
          'INSERT INTO accounts (username, nickname, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(username, nickname, passwordHash, passwordSalt, Date.now());
      const id = num(info.lastInsertRowid);
      return this.findAccountById(id);
    } catch (e) {
      // UNIQUE 冲突 → 用户名已存在
      if (String((e as Error).message).includes('UNIQUE')) return null;
      throw e;
    }
  }

  #rowToAccount(row: Record<string, unknown> | undefined): AccountWithSecret | null {
    if (!row) return null;
    return {
      id: num(row.id),
      username: str(row.username),
      nickname: str(row.nickname),
      passwordHash: str(row.password_hash),
      passwordSalt: str(row.password_salt),
      createdAt: num(row.created_at),
    };
  }

  findAccountByName(username: string): AccountWithSecret | null {
    return this.#rowToAccount(
      this.#db.prepare('SELECT * FROM accounts WHERE username = ?').get(username),
    );
  }

  findAccountById(id: number): AccountWithSecret | null {
    return this.#rowToAccount(this.#db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  }

  // -------------------------------------------------------------------------
  // 会话
  // -------------------------------------------------------------------------

  createSession(token: string, accountId: number, createdAt: number, expiresAt: number): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, accountId, createdAt, expiresAt);
  }

  findSession(token: string): Session | null {
    const row = this.#db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!row) return null;
    return {
      token: str(row.token),
      accountId: num(row.account_id),
      createdAt: num(row.created_at),
      expiresAt: num(row.expires_at),
    };
  }

  deleteSession(token: string): void {
    this.#db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  purgeExpiredSessions(now: number): number {
    return num(this.#db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes);
  }

  // -------------------------------------------------------------------------
  // 房间落座
  // -------------------------------------------------------------------------

  upsertSeat(seat: PersistedSeat): void {
    this.#db
      .prepare(
        `INSERT INTO room_members (code, account_id, seat, nickname, joined_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code, account_id) DO UPDATE SET seat = excluded.seat, nickname = excluded.nickname`,
      )
      .run(seat.code, seat.accountId, seat.seat, seat.nickname, seat.joinedAt);
  }

  seatsOfRoom(code: string): readonly PersistedSeat[] {
    return this.#db
      .prepare('SELECT * FROM room_members WHERE code = ? ORDER BY joined_at ASC')
      .all(code)
      .map((r) => ({
        code: str(r.code),
        accountId: num(r.account_id),
        seat: r.seat === null || r.seat === undefined ? null : num(r.seat),
        nickname: str(r.nickname),
        joinedAt: num(r.joined_at),
      }));
  }

  roomsOfAccount(accountId: number): readonly PersistedSeat[] {
    return this.#db
      .prepare('SELECT * FROM room_members WHERE account_id = ? ORDER BY joined_at DESC')
      .all(accountId)
      .map((r) => ({
        code: str(r.code),
        accountId: num(r.account_id),
        seat: r.seat === null || r.seat === undefined ? null : num(r.seat),
        nickname: str(r.nickname),
        joinedAt: num(r.joined_at),
      }));
  }

  deleteSeat(code: string, accountId: number): void {
    this.#db.prepare('DELETE FROM room_members WHERE code = ? AND account_id = ?').run(code, accountId);
  }

  // -------------------------------------------------------------------------
  // 对局
  // -------------------------------------------------------------------------

  saveGame(game: PersistedGame): void {
    this.#db
      .prepare(
        `INSERT INTO games (code, status, game_json, version, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           status = excluded.status, game_json = excluded.game_json,
           version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(game.code, game.status, game.gameJson, game.version, game.updatedAt);
  }

  loadGame(code: string): PersistedGame | null {
    const row = this.#db.prepare('SELECT * FROM games WHERE code = ?').get(code);
    if (!row) return null;
    return {
      code: str(row.code),
      status: str(row.status),
      gameJson: str(row.game_json),
      version: num(row.version),
      updatedAt: num(row.updated_at),
    };
  }

  deleteGame(code: string): void {
    this.#db.prepare('DELETE FROM games WHERE code = ?').run(code);
  }

  listLiveGames(): readonly PersistedGame[] {
    return this.#db
      .prepare("SELECT * FROM games WHERE status != 'finished' ORDER BY updated_at DESC")
      .all()
      .map((r) => ({
        code: str(r.code),
        status: str(r.status),
        gameJson: str(r.game_json),
        version: num(r.version),
        updatedAt: num(r.updated_at),
      }));
  }

  close(): void {
    this.#db.close();
  }
}

/** 从 AccountWithSecret 剥离密码信息 */
export function publicAccount(a: AccountWithSecret): Account {
  return { id: a.id, username: a.username, nickname: a.nickname, createdAt: a.createdAt };
}
