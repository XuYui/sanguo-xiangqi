/**
 * Socket.IO 端到端联机测试
 *
 * 真实起一个 HTTP+Socket.IO 服务（随机端口），用三个客户端走完整流程：
 * 建房 → 三人加入自动开局 → 依次走子 → 观战者只读 → 断线重连 → 认输结束。
 * 这一层验证的是「传输 ↔ 房间」的接线，而不是棋规（棋规已由 core 的测试覆盖）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import { startServer, type StartedServer } from '../src/index.ts';

// 测试会注册十几个账号，默认限流（同 IP 每分钟 10 次）会挡住；
// 必须在启动服务前设置——限流器的阈值是惰性读取的。
process.env.AUTH_RATE_MAX = '10000';

interface TestClient {
  readonly socket: ClientSocket;
  readonly inbox: any[];
  /** clientId（服务端 ready 事件给出） */
  readonly ready: Promise<{ clientId: string; maxSeats: number }>;
  join(code: string): Promise<void>;
  send(msg: unknown): void;
  waitFor(predicate: (msg: any, kind: 'reply' | 'broadcast') => boolean, timeoutMs?: number): Promise<any>;
  snapshot(): any;
  close(): void;
}

/**
 * 注册一个测试账号并返回会话令牌。
 *
 * 账号系统上线后，**只有登录用户能落座参战**（匿名只能观战），
 * 所以端到端测试必须先注册再连接。
 */
let accountSeq = 0;
async function register(url: string, nickname: string): Promise<string> {
  accountSeq += 1;
  const username = `e2e_${Date.now().toString(36)}_${accountSeq}`;
  const r = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'test-password', nickname }),
  });
  const body = (await r.json()) as { ok: boolean; token?: string; error?: string };
  if (!body.ok || !body.token) throw new Error(`注册失败：${body.error ?? r.status}`);
  return body.token;
}

function connect(url: string, token?: string): TestClient {
  const socket = ioClient(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    ...(token ? { auth: { token } } : {}),
  });
  const inbox: any[] = [];
  let resolveReady: (v: any) => void;
  const ready = new Promise<any>((res) => {
    resolveReady = res;
  });

  socket.on('ready', (payload) => resolveReady(payload));
  socket.on('reply', (msg) => inbox.push({ kind: 'reply', msg }));
  socket.on('broadcast', (msg) => inbox.push({ kind: 'broadcast', msg }));
  socket.on('joined', (msg) => inbox.push({ kind: 'joined', msg }));

  const joined = new Set<string>();

  return {
    socket,
    inbox,
    ready,
    async join(code: string) {
      if (joined.has(code)) return;
      await new Promise<void>((res) => socket.emit('joinRoom', { code }, () => res()));
      joined.add(code);
      // 等 joined 事件落地
      await new Promise((res) => setTimeout(res, 20));
    },
    send(msg: unknown) {
      socket.emit('msg', msg);
    },
    waitFor(predicate, timeoutMs = 3000) {
      return new Promise((res, rej) => {
        const check = () => {
          const hit = inbox.find((e) => predicate(e.msg, e.kind));
          if (hit) {
            clearInterval(timer);
            res(hit.msg);
          }
        };
        const timer = setInterval(check, 5);
        check();
        setTimeout(() => {
          clearInterval(timer);
          rej(new Error(`等待消息超时；已收到: ${JSON.stringify(inbox.map((e) => e.msg?.type))}`));
        }, timeoutMs);
      });
    },
    snapshot() {
      const snaps = inbox.filter((e) => e.msg?.type === 'snapshot');
      return snaps.at(-1)?.msg.snapshot;
    },
    close() {
      socket.close();
    },
  };
}

async function withServer(fn: (srv: StartedServer, url: string) => Promise<void>): Promise<void> {
  const srv = await startServer(0, '127.0.0.1', { dbFile: ':memory:' });
  const url = `http://127.0.0.1:${srv.port}`;
  try {
    await fn(srv, url);
  } finally {
    await srv.close();
  }
}

/** 三家加入并开局，返回三个客户端 */
async function threePlayers(
  url: string,
  code: string,
  names: [string, string, string] = ['魏家', '蜀家', '吴家'],
): Promise<[TestClient, TestClient, TestClient]> {
  const [ta, tb, tc] = await Promise.all([
    register(url, names[0]),
    register(url, names[1]),
    register(url, names[2]),
  ]);
  const a = connect(url, ta);
  const b = connect(url, tb);
  const c = connect(url, tc);
  await Promise.all([a.ready, b.ready, c.ready]);

  await a.join(code);
  a.send({ type: 'join', nickname: '魏家' });
  await a.waitFor((m) => m.type === 'welcome');

  await b.join(code);
  b.send({ type: 'join', nickname: '蜀家' });
  await b.waitFor((m) => m.type === 'welcome');

  await c.join(code);
  c.send({ type: 'join', nickname: '吴家' });
  await c.waitFor((m) => m.type === 'welcome');

  // 进房**不会**自动占座：三家各自选一个势力，最后一位落座即自动开局
  a.send({ type: 'takeSeat', seat: 0 });
  b.send({ type: 'takeSeat', seat: 1 });
  c.send({ type: 'takeSeat', seat: 2 });

  // 等开局快照
  await a.waitFor((m) => m.type === 'snapshot' && m.snapshot.status === 'playing');
  return [a, b, c];
}

test('端到端：建房 → 三人加入 → 自动开局 → 同步走子', async () => {
  await withServer(async (_srv, url) => {
    const code = 'E2E1';
    const [a, b, c] = await threePlayers(url, code);
    try {
      const snap = a.snapshot();
      assert.equal(snap.code, code);
      assert.equal(snap.status, 'playing');
      assert.equal(snap.game.turn, 'wei');
      assert.equal(Object.keys(snap.game.pieces).length, 48);
      // 三家昵称与座位
      assert.deepEqual(
        snap.players.map((p: any) => [p.seat, p.nickname]),
        [
          [0, '魏家'],
          [1, '蜀家'],
          [2, '吴家'],
        ],
      );

      // 魏走一步
      a.send({ type: 'move', from: 'wei:5,4', to: 'wei:5,5', version: snap.version });
      const after = await b.waitFor((m) => m.type === 'snapshot' && m.snapshot.game?.ply === 1);
      assert.equal(after.snapshot.game.turn, 'shu');
      assert.equal(after.snapshot.game.pieces['wei:5,5'].kind, 'soldier');

      // 蜀接着走
      b.send({ type: 'move', from: 'shu:5,4', to: 'shu:5,5', version: after.snapshot.version });
      const after2 = await c.waitFor((m) => m.type === 'snapshot' && m.snapshot.game?.ply === 2);
      assert.equal(after2.snapshot.game.turn, 'wu');

      // 吴走
      c.send({ type: 'move', from: 'wu:5,4', to: 'wu:5,5', version: after2.snapshot.version });
      const after3 = await a.waitFor((m) => m.type === 'snapshot' && m.snapshot.game?.ply === 3);
      assert.equal(after3.snapshot.game.turn, 'wei', '三家各走一步后回到魏');
      assert.equal(after3.snapshot.game.history.length, 3);
    } finally {
      a.close();
      b.close();
      c.close();
    }
  });
});

test('端到端：非本方回合走子被拒，观战者只读', async () => {
  await withServer(async (_srv, url) => {
    const [a, b, c] = await threePlayers(url, 'E2E2');
    // 观战者也要有账号：匿名访客会被 loginRequired 拦下（那是另一条分支），
    // 这里要验证的是「有账号但没落座」→ notSeated
    const watcher = connect(url, await register(url, '看戏的'));
    try {
      await watcher.ready;
      await watcher.join('E2E2');
      watcher.send({ type: 'join', nickname: '看戏的' });
      await watcher.waitFor((m) => m.type === 'welcome');

      // 不是蜀的回合，蜀走子 -> notYourTurn
      b.send({ type: 'move', from: 'shu:5,4', to: 'shu:5,5', version: a.snapshot().version });
      const e1 = await b.waitFor((m) => m.type === 'error');
      assert.equal(e1.code, 'notYourTurn');

      // 观战者走子 -> notSeated
      watcher.send({ type: 'move', from: 'wei:5,4', to: 'wei:5,5', version: a.snapshot().version });
      const e2 = await watcher.waitFor((m) => m.type === 'error');
      assert.equal(e2.code, 'notSeated');

      // 观战者能收到广播快照
      a.send({ type: 'move', from: 'wei:5,4', to: 'wei:5,5', version: a.snapshot().version });
      const seen = await watcher.waitFor((m) => m.type === 'snapshot' && m.snapshot.game?.ply === 1);
      assert.equal(seen.snapshot.game.ply, 1);
      assert.equal(seen.snapshot.players.find((p: any) => p.nickname === '看戏的').seat, null);
    } finally {
      a.close();
      b.close();
      c.close();
      watcher.close();
    }
  });
});

test('端到端：断线重连凭 token 回到原座位，对局状态不丢', async () => {
  await withServer(async (_srv, url) => {
    const [a, b, c] = await threePlayers(url, 'E2E3');
    let token = '';
    try {
      a.send({ type: 'move', from: 'wei:5,4', to: 'wei:5,5', version: a.snapshot().version });
      await b.waitFor((m) => m.type === 'snapshot' && m.snapshot.game?.ply === 1);
      const welcome = a.inbox.find((e) => e.msg.type === 'welcome')!.msg;
      token = welcome.token;

      a.close(); // 断线
      await b.waitFor(
        (m) => m.type === 'snapshot' && m.snapshot.players.some((p: any) => p.online === false),
        4000,
      );

      // 新连接 + token 重连
      const again = connect(url);
      await again.ready;
      await again.join('E2E3');
      again.send({ type: 'join', nickname: '魏家', token });
      const re = await again.waitFor((m) => m.type === 'welcome');
      assert.equal(re.clientId, welcome.clientId, '应恢复原 clientId');
      assert.equal(re.snapshot.game.ply, 1, '对局状态应保留');
      assert.equal(re.snapshot.game.turn, 'shu');
      assert.equal(re.snapshot.players.find((p: any) => p.clientId === welcome.clientId).online, true);
      again.close();
    } finally {
      b.close();
      c.close();
    }
  });
});

test('端到端：认输广播并结束对局', async () => {
  await withServer(async (_srv, url) => {
    const [a, b, c] = await threePlayers(url, 'E2E4');
    try {
      b.send({ type: 'resign' });
      const mid = await a.waitFor(
        (m) => m.type === 'snapshot' && m.snapshot.game?.status?.shu === 'resigned',
      );
      assert.equal(mid.snapshot.status, 'playing', '还剩两家，对局继续');
      c.send({ type: 'resign' });
      const fin = await a.waitFor((m) => m.type === 'snapshot' && m.snapshot.status === 'finished');
      assert.equal(fin.snapshot.game.phase, 'finished');
      assert.equal(fin.snapshot.game.winner, 'wei');
    } finally {
      a.close();
      b.close();
      c.close();
    }
  });
});

test('端到端：/healthz 可访问，非法房间码被拒', async () => {
  await withServer(async (srv, url) => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; rooms: number };
    assert.equal(body.ok, true);
    assert.equal(typeof body.rooms, 'number');

    const cli = connect(url);
    try {
      await cli.ready;
      const ack = await new Promise<any>((res) => cli.socket.emit('joinRoom', { code: 'a' }, res));
      assert.equal(ack.ok, false, '过短的房间码应被拒');
    } finally {
      cli.close();
    }
  });
});

test('端到端：未加入房间就发消息得到 noRoom', async () => {
  await withServer(async (_srv, url) => {
    const cli = connect(url);
    try {
      await cli.ready;
      cli.send({ type: 'move', from: 'wei:5,4', to: 'wei:5,5', version: 0 });
      const e = await cli.waitFor((m) => m.type === 'error');
      assert.equal(e.code, 'noRoom');
    } finally {
      cli.close();
    }
  });
});

test('端到端：规则拒绝时 Socket.IO ack 返回失败', async () => {
  await withServer(async (_srv, url) => {
    const token = await register(url, 'ack玩家');
    const client = connect(url, token);
    try {
      await client.ready;
      await client.join('ACK1');
      client.send({ type: 'join', nickname: 'ack玩家' });
      await client.waitFor((m) => m.type === 'welcome');
      const ack = await new Promise<any>((resolve) => {
        client.socket.emit('msg', { type: 'takeSeat', seat: 9 }, resolve);
      });
      assert.deepEqual(ack, { ok: false, error: '座位号无效', code: 'badSeat' });
    } finally {
      client.close();
    }
  });
});

test('切换房间后不再收到旧房间的广播', async () => {
  await withServer(async (_srv, url) => {
    const firstToken = await register(url, '切房玩家');
    const otherToken = await register(url, '旧房玩家');
    const client = connect(url, firstToken);
    const other = connect(url, otherToken);
    try {
      await client.ready;
      await other.ready;
      await client.join('ROOMA');
      client.send({ type: 'join', nickname: '切房玩家' });
      await client.waitFor((m) => m.type === 'welcome');

      await client.join('ROOMB');
      client.send({ type: 'join', nickname: '切房玩家' });
      await client.waitFor((m) => m.type === 'welcome' && m.snapshot.code === 'ROOMB');
      client.inbox.length = 0;

      await other.join('ROOMA');
      other.send({ type: 'join', nickname: '旧房玩家' });
      await other.waitFor((m) => m.type === 'welcome');
      other.send({ type: 'takeSeat', seat: 0 });
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(
        client.inbox.some((e) => e.kind === 'broadcast' && e.msg.type === 'snapshot' && e.msg.snapshot.code === 'ROOMA'),
        false,
      );
    } finally {
      client.close();
      other.close();
    }
  });
});
