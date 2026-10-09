/**
 * 账号相关的 HTTP 接口。
 *
 *   POST /api/auth/register  { username, password, nickname? } → { account, token, expiresAt }
 *   POST /api/auth/login     { username, password }            → { account, token, expiresAt }
 *   POST /api/auth/logout    （需 Authorization: Bearer）       → { ok: true }
 *   GET  /api/auth/me        （需 Authorization: Bearer）       → { account }
 *
 * 说明：
 *  - 只用 Node 内置能力，无第三方框架；
 *  - 请求体限制 8 KB、限流按「用户名+IP」双维度，避免暴力破解；
 *  - 所有响应都带 Cache-Control: no-store（会话令牌绝不能被缓存）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthService } from './auth.ts';
import type { Account } from './store.ts';

const MAX_BODY = 8 * 1024;

/** 简单滑动窗口限流：同一 key 在 windowMs 内最多 max 次 */
class RateLimiter {
  #hits = new Map<string, number[]>();  #max: number;
  #windowMs: number;

  constructor(max: number, windowMs: number) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  /** 返回 true 表示允许 */
  allow(key: string, now = Date.now()): boolean {
    const list = (this.#hits.get(key) ?? []).filter((t) => now - t < this.#windowMs);
    if (list.length >= this.#max) {
      this.#hits.set(key, list);
      return false;
    }
    list.push(now);
    this.#hits.set(key, list);
    // 顺手清理过大的映射，避免内存无限增长
    if (this.#hits.size > 5000) {
      for (const [k, v] of this.#hits) {
        if (v.every((t) => now - t >= this.#windowMs)) this.#hits.delete(k);
      }
    }
    return true;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** 从 Authorization: Bearer <token> 取令牌 */
export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || null;
}

function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

export interface AuthHttpOptions {
  readonly auth: AuthService;
}

/**
 * 处理 /api/auth/* 请求。
 * @returns true 表示已处理（调用方不要再走静态文件逻辑）
 */
export function handleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  opts: AuthHttpOptions,
): boolean {
  if (!pathname.startsWith('/api/auth/')) return false;

  const { auth } = opts;
  const method = req.method ?? 'GET';

  // 登录/注册限流：60 秒内同一 IP 或同一用户名最多 10 次
  const loginLimiter = limiterFor('login');
  const registerLimiter = limiterFor('register');

  const run = async (): Promise<void> => {
    if (pathname === '/api/auth/me' && method === 'GET') {
      const acc = auth.verify(bearerToken(req));
      if (!acc) return json(res, 401, { ok: false, error: '未登录或登录已过期', code: 'unauthorized' });
      return json(res, 200, { ok: true, account: publicAcc(acc) });
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      auth.logout(bearerToken(req));
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/auth/register' && method === 'POST') {
      const body = await readBody(req);
      if (!body) return json(res, 400, { ok: false, error: '请求格式不正确', code: 'badRequest' });
      const username = String(body.username ?? '').trim();
      if (!registerLimiter.allow(`ip:${clientIp(req)}`)) {
        return json(res, 429, { ok: false, error: '操作过于频繁，请稍后再试', code: 'rateLimited' });
      }
      const r = auth.register(username, String(body.password ?? ''), String(body.nickname ?? ''));
      if (!r.ok || !r.value) return json(res, 400, { ok: false, error: r.error, code: r.errorCode });
      return json(res, 200, {
        ok: true,
        account: publicAcc(r.value.account),
        token: r.value.token,
        expiresAt: r.value.expiresAt,
      });
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req);
      if (!body) return json(res, 400, { ok: false, error: '请求格式不正确', code: 'badRequest' });
      const username = String(body.username ?? '').trim();
      if (!loginLimiter.allow(`ip:${clientIp(req)}`) || !loginLimiter.allow(`user:${username}`)) {
        return json(res, 429, {
          ok: false,
          error: '尝试次数过多，请稍后再试',
          code: 'rateLimited',
        });
      }
      const r = auth.login(username, String(body.password ?? ''));
      if (!r.ok || !r.value) {
        // 统一 401，但把失败也计入用户名维度，防止撞库
        return json(res, 401, { ok: false, error: r.error, code: r.errorCode });
      }
      return json(res, 200, {
        ok: true,
        account: publicAcc(r.value.account),
        token: r.value.token,
        expiresAt: r.value.expiresAt,
      });
    }

    json(res, 404, { ok: false, error: '接口不存在', code: 'notFound' });
  };

  void run().catch(() => {
    if (!res.headersSent) json(res, 500, { ok: false, error: '服务器内部错误', code: 'internal' });
  });
  return true;
}

function publicAcc(a: Account): Account {
  return { id: a.id, username: a.username, nickname: a.nickname, createdAt: a.createdAt };
}

/** 限流器实例（模块级，按需创建） */
const LIMITERS = new Map<string, RateLimiter>();

/**
 * 限流阈值。
 *
 * 默认：同一 IP 每 60 秒最多 30 次登录/注册尝试。
 * 这是防暴力破解的下限保护（单机小站，30/分钟对正常用户完全够用，
 * 但对自动化测试/内网批量注册可能偏紧），可用环境变量调整：
 *   AUTH_RATE_MAX=1000 AUTH_RATE_WINDOW_MS=1000
 */
const RATE_MAX = Number(process.env.AUTH_RATE_MAX ?? 30);
const RATE_WINDOW_MS = Number(process.env.AUTH_RATE_WINDOW_MS ?? 60_000);

function limiterFor(kind: string): RateLimiter {
  let l = LIMITERS.get(kind);
  if (!l) {
    l = new RateLimiter(RATE_MAX, RATE_WINDOW_MS);
    LIMITERS.set(kind, l);
  }
  return l;
}

/** 仅供测试：重置限流状态 */
export function resetRateLimiters(): void {
  LIMITERS.clear();
}
