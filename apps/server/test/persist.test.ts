/**
 * 持久化端到端测试：账号 → 落座 → 对局，跨连接与跨服务重启都不丢。
 *
 * 这正是用户要的效果：
 *   「每一次进入，是否在局内、该谁走，只需要记载在账号下」
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import { startServer, type StartedServer } from '../src/index.ts';

interface Cli {
  socket: ClientSocket;
  inbox: any[];
  readonly ready: Promise<any>;
  join(code: string): Promise<any>;
  send(msg: unknown): void;
  waitFor(pred: (m: any) => boolean, ms?: number): Promise<any>;
  close(): void;
}

function connect(url: string, token?: string): Cli {
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
  socket.on('ready', (p) => resolveReady(p));
  socket.on('reply', (m) => inbox.push(m));
  socket.on('broadcast', (m) => inbox.push(m));
  socket.on('joined', (m) => inbox.push(m));

  return {
    socket,
    inbox,
    ready,
    async join(code) {
      const ack = await new Promise<any>((res) => socket.emit('joinRoom', { code }, res));
      await new Promise((r) => setTimeout(r, 30));
      return ack;
    },
    send(msg) {
      socket.emit('msg', msg);
    },
    waitFor(pred, ms = 4000) {
      return new Promise((res, rej) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
          const hit = inbox.find(pred);
          if (hit) {
            clearInterval(timer);
            res(hit);
          } else if (Date.now() - t0 > ms) {
            clearInterval(timer);
            rej(new Error(`超时；已收到: ${JSON.stringify(inbox.map((m) => m?.type ?? m?.code))}`));
          }
        }, 10);
      });
    },
    close() {
      socket.close();
    },
  };
}

async function register(url: string, nickname: string): Promise<string> {
  const username = `persist_${Math.random().toString(36).slice(2, 10)}`;
  const r = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'test-password', nickname }),
  });
  const body = (await r.json()) as { ok: boolean; token?: string; error?: string };
  if (!body.ok || !body.token) throw new Error(`注册失败：${body.error}`);
  return body.token;
}

const lastSnap = (c: Cli) => [...c.inbox].reverse().find((m) => m?.type === 'snapshot')?.snapshot;

async function withServer(
  dbFile: string,
  fn: (srv: StartedServer, url: string) => Promise<void>,
): Promise<void> {
  const srv = await startServer(0, '127.0.0.1', { dbFile });
  try {
    await fn(srv, `http://127.0.0.1:${srv.port}`);
  } finally {
    await srv.close();
  }
}

// ---------------------------------------------------------------------------

test('持久化：凭账号重新连接（模拟刷新）能回到原座位，对局与轮次不丢', async () => {
  await withServer(':memory:', async (_srv, url) => {
    const CODE = 'PERS1';
    const tokens = await Promise.all([
      register(url, '魏家'),
      register(url, '蜀家'),
      register(url, '吴家'),
    ]);

    // 三家登录并加入 → 自动开局
    const clients = tokens.map((t) => connect(url, t));
    await Promise.all(clients.map((c) => c.ready));
    for (let i = 0; i < 3; i++) {
      await clients[i]!.join(CODE);
      clients[i]!.send({ type: 'join', nickname: ['魏家', '蜀家', '吴家'][i] });
    }
    // 显式选势力（进房不再自动占座）
    for (let i = 0; i < 3; i++) clients[i]!.send({ type: 'takeSeat', seat: i });
    await clients[0]!.waitFor((m) => m?.type === 'snapshot' && m.snapshot.status === 'playing');
    const snap0 = lastSnap(clients[0]!)!;
    assert.equal(Object.keys(snap0.game.pieces).length, 48, '开局应有 48 子');

    // 第一手：魏走一步
    const ver = snap0.version;
    clients[0]!.send({ type: 'move', from: 'wei:5,4', to: 'wei:5,5', version: ver });
    const afterMove = await clients[1]!.waitFor((m) => m?.type === 'snapshot' && m.snapshot.game?.ply === 1);
    assert.equal(afterMove.snapshot.game.turn, 'shu', '魏走完后轮到蜀');

    // ---- 模拟「玩家刷新页面」：关掉魏的连接，用同一个账号令牌重新连 ----
    clients[0]!.close();
    await new Promise((r) => setTimeout(r, 120));

    const reconnected = connect(url, tokens[0]!);
    await reconnected.ready;
    await reconnected.join(CODE);
    reconnected.send({ type: 'join', nickname: '魏家' });
    const snapR = await reconnected.waitFor(
      (m) => m?.type === 'snapshot' && m.snapshot.game?.ply === 1 && m.snapshot.status === 'playing',
    );

    // 关键断言：还是原来那一家、坐在原来那个座位
    const me = snapR.snapshot.players.find((p: any) => p.seat === 0);
    assert.equal(me.nickname, '魏家', '座位 0 应该还是魏家（账号身份稳定）');
    assert.equal(snapR.snapshot.game.turn, 'shu', '轮次没有因为重连而错乱');
    assert.equal(snapR.snapshot.game.history.length, 1, '行棋记录保留');
    assert.equal(Object.keys(snapR.snapshot.game.pieces).length, 48);

    // 重新连上后仍然认得自己是哪一家（账号 id = 成员 id）
    const readyInfo = await reconnected.ready;
    assert.equal(String(readyInfo.clientId), String(me.clientId), 'ready.clientId 应等于账号成员 id');

    for (const c of clients) c.close();
    reconnected.close();
  });
});

test('持久化：服务重启后，落座与对局从磁盘恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sanguo-persist-'));
  const dbFile = join(dir, 'sanguo.db');
  const CODE = 'PERS2';
  let tokens: string[] = [];
  let historyLen = 0;

  try {
    // ---- 第一次启动：开局并走两手 ----
    await withServer(dbFile, async (_srv, url) => {
      tokens = await Promise.all([
        register(url, '魏家'),
        register(url, '蜀家'),
        register(url, '吴家'),
      ]);
      const clients = tokens.map((t) => connect(url, t));
      await Promise.all(clients.map((c) => c.ready));
      for (let i = 0; i < 3; i++) {
        await clients[i]!.join(CODE);
        clients[i]!.send({ type: 'join', nickname: ['魏家', '蜀家', '吴家'][i] });
      }
      for (let i = 0; i < 3; i++) clients[i]!.send({ type: 'takeSeat', seat: i });
      await clients[0]!.waitFor((m) => m?.type === 'snapshot' && m.snapshot.status === 'playing');

      // 魏走一步
      clients[0]!.send({
        type: 'move', from: 'wei:5,4', to: 'wei:5,5',
        version: lastSnap(clients[0]!)!.version,
      });
      await clients[1]!.waitFor((m) => m?.type === 'snapshot' && m.snapshot.game?.ply === 1);
      // 蜀走一步
      clients[1]!.send({
        type: 'move', from: 'shu:5,4', to: 'shu:5,5',
        version: lastSnap(clients[1]!)!.version,
      });
      const s = await clients[2]!.waitFor((m) => m?.type === 'snapshot' && m.snapshot.game?.ply === 2);
      historyLen = s.snapshot.game.history.length;
      for (const c of clients) c.close();
    });

    assert.equal(historyLen, 2, '重启前应有 2 条行棋记录');

    // ---- 第二次启动：换一个全新进程内状态，数据应从磁盘恢复 ----
    await withServer(dbFile, async (_srv, url) => {
      const c = connect(url, tokens[0]!);
      await c.ready;
      await c.join(CODE);
      c.send({ type: 'join', nickname: '魏家' });
      const snap = await c.waitFor(
        (m) => m?.type === 'snapshot' && m.snapshot.status === 'playing',
      );
      assert.equal(snap.snapshot.game.history.length, 2, '重启后行棋记录还在');
      assert.equal(snap.snapshot.game.turn, 'wu', '重启后轮次正确（魏、蜀已走，轮到吴）');
      assert.equal(snap.snapshot.players.length, 3, '重启后三名成员都还在');
      const seats = snap.snapshot.players.map((p: any) => p.seat).sort();
      assert.deepEqual(seats, [0, 1, 2], '座位分配保留');
      // 恢复回来的成员默认离线，重新连上后才在线
      const me = snap.snapshot.players.find((p: any) => p.nickname === '魏家');
      assert.equal(me.online, true, '重新连上的那位应显示在线');
      c.close();
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
