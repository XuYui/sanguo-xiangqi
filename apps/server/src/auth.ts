/**
 * 账号认证：注册、登录、会话校验。
 *
 * 设计要点：
 *  - 密码用 **scrypt**（Node 内置）+ 每账号独立随机盐；校验用 timingSafeEqual。
 *  - 会话令牌是 32 字节随机 hex，存库并带 90 天有效期；
 *    客户端把它放在 Authorization: Bearer 和 Socket.IO 握手里。
 *  - 会话令牌只在**创建时**返回明文，库里存的就是令牌本身（随机值，非密码），
 *    这是无状态令牌的常规做法；如需更强可换成哈希存储，但当前规模无必要。
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import {
  MIN_PASSWORD_LENGTH,
  USERNAME_RE,
  type Account,
  type AuthStore,
} from './store.ts';

/** 会话有效期：90 天 */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const SCRYPT_KEYLEN = 64;

export interface AuthResult<T> {
  readonly ok: boolean;
  readonly error?: string;
  readonly errorCode?: string;
  readonly value?: T;
}

export interface LoginResult {
  readonly account: Account;
  readonly token: string;
  readonly expiresAt: number;
}

export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt ?? randomBytes(16).toString('hex');
  const hash = scryptSync(password, s, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt: s };
}

export function verifyPassword(password: string, expectedHash: string, salt: string): boolean {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class AuthService {
  #store: AuthStore;
  #now: () => number;

  constructor(store: AuthStore, now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
  }

  // -------------------------------------------------------------------------
  // 注册
  // -------------------------------------------------------------------------

  register(
    username: string | undefined,
    password: string | undefined,
    nickname?: string,
  ): AuthResult<LoginResult> {
    const name = (username ?? '').trim();
    const nick = (nickname ?? '').trim() || name;

    if (!USERNAME_RE.test(name)) {
      return {
        ok: false,
        error: '用户名需为 3~16 位字母、数字或下划线',
        errorCode: 'badUsername',
      };
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return {
        ok: false,
        error: `密码至少 ${MIN_PASSWORD_LENGTH} 位`,
        errorCode: 'badPassword',
      };
    }
    if (nick.length > 16) {
      return { ok: false, error: '昵称最多 16 个字', errorCode: 'badNickname' };
    }
    if (this.#store.findAccountByName(name)) {
      return { ok: false, error: '该用户名已被注册', errorCode: 'usernameTaken' };
    }

    const { hash, salt } = hashPassword(password);
    const created = this.#store.createAccount(name, nick, hash, salt);
    if (!created) {
      // 并发注册撞车
      return { ok: false, error: '该用户名已被注册', errorCode: 'usernameTaken' };
    }
    return { ok: true, value: this.#issue(created.id, name, nick, created.createdAt) };
  }

  // -------------------------------------------------------------------------
  // 登录
  // -------------------------------------------------------------------------

  login(username: string | undefined, password: string | undefined): AuthResult<LoginResult> {
    const name = (username ?? '').trim();
    const acc = this.#store.findAccountByName(name);
    // 不区分「用户不存在」与「密码错」，避免账号枚举
    if (!acc || !verifyPassword(String(password ?? ''), acc.passwordHash, acc.passwordSalt)) {
      return { ok: false, error: '用户名或密码不正确', errorCode: 'badCredentials' };
    }
    return { ok: true, value: this.#issue(acc.id, acc.username, acc.nickname, acc.createdAt) };
  }

  /** 校验会话令牌；过期会顺手删掉 */
  verify(token: string | null | undefined): Account | null {
    if (!token) return null;
    const s = this.#store.findSession(token);
    if (!s) return null;
    if (s.expiresAt <= this.#now()) {
      this.#store.deleteSession(token);
      return null;
    }
    const acc = this.#store.findAccountById(s.accountId);
    if (!acc) {
      this.#store.deleteSession(token);
      return null;
    }
    return { id: acc.id, username: acc.username, nickname: acc.nickname, createdAt: acc.createdAt };
  }

  logout(token: string | null | undefined): void {
    if (token) this.#store.deleteSession(token);
  }

  /** 定期清理过期会话（由服务端定时调用） */
  purgeExpired(): number {
    return this.#store.purgeExpiredSessions(this.#now());
  }

  #issue(accountId: number, username: string, nickname: string, createdAt: number): LoginResult {
    const token = randomBytes(32).toString('hex');
    const now = this.#now();
    const expiresAt = now + SESSION_TTL_MS;
    this.#store.createSession(token, accountId, now, expiresAt);
    return { account: { id: accountId, username, nickname, createdAt }, token, expiresAt };
  }
}
