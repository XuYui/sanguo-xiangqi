/**
 * 对局服务器入口
 *
 * 职责：
 *  - Socket.IO 联机（房间邀请码 / 观战 / 断线重连）
 *  - 静态前端托管（生产环境交给 nginx，这里作为本地开发与兜底）
 *  - /healthz 健康检查（systemd / nginx / 监控用）
 *
 * 环境变量：
 *  PORT          监听端口（默认 3011）
 *  HOST          监听地址（默认 0.0.0.0）
 *  CLIENT_DIST   前端构建产物目录（存在则托管）
 *  CORS_ORIGINS  允许的跨域来源，逗号分隔（同源部署留空）
 *
 * 用法：
 *   node --experimental-strip-types apps/server/src/index.ts   # 直接启动
 *   const s = await startServer(0)                             # 测试里随机端口启动
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AuthService } from './auth.ts';
import { handleAuthRequest } from './auth-http.ts';
import { SqliteStore } from './sqlite-store.ts';
import { attachTransport, type Transport } from './transport.ts';
import type { AuthStore } from './store.ts';

const PORT = Number(process.env.PORT ?? 3011);
const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * 数据库文件位置。
 *
 * 默认放在服务目录的 `data/sanguo.db`：
 *  - 构建产物是 .build/，解包到服务器 /opt/sanguo-xiangqi/，所以即 /opt/sanguo-xiangqi/data/；
 *  - 可用环境变量 DB_FILE 覆盖（测试用 :memory:）。
 */
function resolveDbFile(): string {
  if (process.env.DB_FILE) return process.env.DB_FILE;
  return join(import.meta.dirname, 'data', 'sanguo.db');
}

/**
 * 前端静态目录。
 *
 * 两种运行形态都要照顾到：
 *  - 开发（直接跑 TS）：apps/server/src → ../../web/public
 *  - 生产（构建产物）：.build/index.js → ./web
 * 所以按顺序探测，第一个存在的就用；也可用 CLIENT_DIST 显式指定。
 */
function resolveClientDist(): string {
  if (process.env.CLIENT_DIST) return resolve(process.env.CLIENT_DIST);
  const here = import.meta.dirname;
  const candidates = [
    join(here, 'web'), // 构建产物：.build/index.js + .build/web
    join(here, '..', '..', 'web', 'public'), // 开发：apps/server/src/index.ts
    join(here, '..', 'web', 'public'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return resolve(c);
  }
  return resolve(candidates[0]!);
}

const CLIENT_DIST = resolveClientDist();
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 静态文件解析。
 *
 * 规则：
 *  1. 规范化路径，禁止目录穿越（解析结果必须仍在 CLIENT_DIST 内）；
 *  2. 命中真实文件就返回（/app/app.js、/public/board.svg、/styles.css 都在这一层）；
 *  3. 否则回退到 index.html（SPA 路由，例如 /?room=ABCD）。
 */
function serveStatic(pathname: string): { status: number; type: string; body: Buffer } | null {
  if (!CLIENT_DIST || !existsSync(CLIENT_DIST)) return null;

  let decoded = '/';
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // 非法百分号编码
  }
  const rel = normalize(decoded).replace(/^([/\\]|\.\.[/\\])+/, '');
  const candidate = resolve(CLIENT_DIST, rel);

  const send = (filePath: string) => {
    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    return { status: 200, type, body: readFileSync(filePath) };
  };

  if (candidate.startsWith(CLIENT_DIST) && existsSync(candidate) && statSync(candidate).isFile()) {
    return send(candidate);
  }
  const index = join(CLIENT_DIST, 'index.html');
  if (existsSync(index)) return send(index);
  return null;
}

function makeHandler(getTransport: () => Transport, getAuth: () => AuthService | null) {
  return function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/healthz') {
      const t = getTransport();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({ ok: true, rooms: t.manager.rooms.size, uptime: Math.round(process.uptime()) }),
      );
      return;
    }

    // 账号接口（注册 / 登录 / 登出 / 我是谁）
    const auth = getAuth();
    if (auth && handleAuthRequest(req, res, url.pathname, { auth })) return;

    if (url.pathname.startsWith('/socket.io')) return; // 交给 Socket.IO 处理

    const file = serveStatic(url.pathname);
    if (file) {
      res.writeHead(file.status, { 'content-type': file.type });
      res.end(file.body);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('三人中国象棋服务已启动。前端未部署或路径不存在。\n');
  };
}

// ---------------------------------------------------------------------------
// 可编程启停
// ---------------------------------------------------------------------------

export interface StartedServer {
  readonly port: number;
  readonly server: Server;
  readonly transport: Transport;
  readonly store: AuthStore;
  readonly auth: AuthService;
  close(): Promise<void>;
}

export interface StartOptions {
  /** 覆盖数据库文件（测试传 ':memory:'） */
  readonly dbFile?: string;
  /** 覆盖 CORS 来源 */
  readonly corsOrigins?: readonly string[];
}

export async function startServer(
  port = 0,
  host = '127.0.0.1',
  options: StartOptions = {},
): Promise<StartedServer> {
  const store = new SqliteStore(options.dbFile ?? resolveDbFile());
  const auth = new AuthService(store);

  let transport: Transport | null = null;
  const server = createServer(makeHandler(() => transport!, () => auth));
  transport = attachTransport(server, {
    corsOrigins: options.corsOrigins ?? CORS_ORIGINS,
    gcIntervalMs: 60_000,
    auth,
    store,
  });
  const tr = transport;
  await new Promise<void>((done) => server.listen(port, host, done));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    port: actualPort,
    server,
    transport: tr,
    store,
    auth,
    close: async () => {
      await tr.close();
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    },
  };
}

// ---------------------------------------------------------------------------
// 直接运行时启动
// ---------------------------------------------------------------------------

/**
 * 判断本模块是否是入口。
 *
 * 注意：不能用 `import.meta.url === 'file://' + process.argv[1]` 字符串比较——
 * `import.meta.url` 是 URL 编码过的（中文目录、空格都会变 %XX），
 * 而 argv[1] 是原始路径，两者永远不相等（会导致服务静默不启动）。
 * 必须统一转成 file URL 再比。
 */
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const store = new SqliteStore(resolveDbFile());
  const auth = new AuthService(store);
  let transport: Transport | null = null;
  const server = createServer(makeHandler(() => transport!, () => auth));
  transport = attachTransport(server, {
    corsOrigins: CORS_ORIGINS,
    gcIntervalMs: 60_000,
    auth,
    store,
  });

  // 定期清理过期会话与空房间
  const sweeper = setInterval(() => {
    try {
      auth.purgeExpired();
    } catch {
      /* 清理失败不影响服务 */
    }
  }, 6 * 60 * 60 * 1000);
  sweeper.unref();

  server.listen(PORT, HOST, () => {
    console.log(`[sanguo] 服务已启动 http://${HOST}:${PORT}`);
    console.log(`[sanguo] 静态目录 = ${CLIENT_DIST ?? '(未配置)'}`);
    console.log(`[sanguo] 数据库   = ${resolveDbFile()}`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[sanguo] 收到 ${signal}，正在关闭…`);
    void transport?.close().finally(() => {
      server.close(() => {
        store.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 3000).unref();
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
