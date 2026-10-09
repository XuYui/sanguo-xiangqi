/**
 * 公网端到端验证
 *
 * 对着真实域名（默认 https://chess.xylab.site）跑一遍完整对局流程，
 * 验证「Cloudflare → nginx → Node → Socket.IO（WebSocket）」整条链路。
 *
 * 用法： node --experimental-strip-types apps/server/tools/verify-public.ts [url]
 */

import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

const URL = process.argv[2] ?? 'https://chess.xylab.site';
const ROOM = 'LIVE' + Math.floor(Math.random() * 900 + 100);
/**
 * 传输方式。
 *
 * Cloudflare 免费版会把 WebSocket 升级转发到源站的 8443 端口；
 * 若该端口在源站未放行，WS 升级就会超时（Socket.IO 会自动降级到 polling，
 * 功能不受影响，只是延迟略高）。
 * 用 --ws 强制只走 websocket，便于单独验证 WS 链路是否通。
 */
const FORCE_WS = process.argv.includes('--ws');
const TRANSPORTS: ('polling' | 'websocket')[] = FORCE_WS
  ? ['websocket']
  : ['polling', 'websocket'];

interface P {
  name: string;
  socket: ClientSocket;
  inbox: any[];
  snapshot: any;
}

async function register(nickname: string): Promise<string> {
  const username = `verify_${Math.random().toString(36).slice(2, 10)}`;
  const response = await fetch(`${URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'verify-pass-123', nickname }),
  });
  const body = (await response.json()) as { token?: string; error?: string };
  if (!response.ok || !body.token) {
    throw new Error(`${nickname} 注册失败：${response.status} ${body.error ?? ''}`.trim());
  }
  return body.token;
}

function connect(name: string, token?: string, seat?: 0 | 1 | 2): Promise<P> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(URL, {
      transports: TRANSPORTS,
      forceNew: true,
      reconnection: false,
      timeout: 15_000,
      withCredentials: false,
      ...(token ? { auth: { token } } : {}),
    });
    const inbox: any[] = [];
    const p: P = { name, socket, inbox, snapshot: null };
    const timer = setTimeout(() => reject(new Error(`${name} 连接超时`)), 15_000);

    socket.on('connect_error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${name} 连接失败: ${e.message}`));
    });
    socket.on('ready', () => {
      socket.emit('joinRoom', { code: ROOM }, (ack: any) => {
        if (!ack?.ok) {
          clearTimeout(timer);
          reject(new Error(`${name} 进房失败: ${ack?.error}`));
          return;
        }
        socket.emit('msg', { type: 'join', nickname: name }, (joinAck: any) => {
          if (joinAck && !joinAck.ok) {
            clearTimeout(timer);
            reject(new Error(`${name} 加入失败: ${joinAck.error}`));
            return;
          }
          const done = () => {
            clearTimeout(timer);
            resolve(p);
          };
          if (seat === undefined) {
            setTimeout(done, 250);
            return;
          }
          socket.emit('msg', { type: 'takeSeat', seat }, (seatAck: any) => {
            if (!seatAck?.ok) {
              clearTimeout(timer);
              reject(new Error(`${name} 落座失败: ${seatAck?.error}`));
              return;
            }
            setTimeout(done, 250);
          });
        });
      });
    });
    socket.on('broadcast', (msg: any) => {
      inbox.push(msg);
      if (msg.type === 'snapshot') p.snapshot = msg.snapshot;
    });
    socket.on('reply', (msg: any) => inbox.push(msg));
  });
}

function waitSnapshot(p: P, pred: (s: any) => boolean, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (p.snapshot && pred(p.snapshot)) {
        clearInterval(t);
        resolve(p.snapshot);
      }
    };
    const t = setInterval(check, 40);
    check();
    setTimeout(() => {
      clearInterval(t);
      reject(new Error(`等快照超时（${p.name}）`));
    }, timeoutMs);
  });
}

async function waitReply(p: P, pred: (m: any) => boolean, timeoutMs = 5000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = p.inbox.find(pred);
    if (reply) return reply;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

function move(p: P, from: string, to: string): void {
  p.socket.emit('msg', { type: 'move', from, to, version: p.snapshot.version });
}

/** 带重试的连接（跨公网/代理时偶发握手失败是常态，必须重试） */
async function connectWithRetry(name: string, token?: string, seat?: 0 | 1 | 2, attempts = 3): Promise<P> {
  let lastErr: Error | null = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await connect(name, token, seat);
    } catch (e) {
      lastErr = e as Error;
      console.log(`  ${name} 第 ${i}/${attempts} 次失败: ${lastErr.message}`);
      await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw lastErr ?? new Error(`${name} 连接失败`);
}

async function main(): Promise<void> {
  console.log(`公网验证目标: ${URL}   房间=${ROOM}   传输=${TRANSPORTS.join('→')}`);
  const results: string[] = [];
  const expect = (ok: boolean, label: string) => {
    results.push(`${ok ? '✔' : '✘'} ${label}`);
    if (!ok) process.exitCode = 1;
  };

  const t0 = Date.now();
  // 逐个连接（并发对 Cloudflare→源站的小机器压力大，容易出现握手超时）
  const tokens = await Promise.all(['公网魏', '公网蜀', '公网吴'].map(register));
  const clients: P[] = [];
  for (const [i, n] of ['魏家', '蜀家', '吴家'].entries()) {
    clients.push(await connectWithRetry(n, tokens[i], i as 0 | 1 | 2));
    await new Promise((r) => setTimeout(r, 250));
  }
  expect(true, `三个客户端依次连接成功（${Date.now() - t0} ms）`);

  const [a, b, c] = clients as [P, P, P];
  try {
    const playing = await waitSnapshot(a, (s) => s.status === 'playing');
    expect(playing.game?.turn === 'wei', '三人到齐后自动开局，首手为魏');
    expect(Object.keys(playing.game.pieces).length === 48, '初始 48 枚棋子');
    expect(playing.seats === undefined || true, ''); // 占位，保持结果对齐
    results.pop();

    // 三家依次走一步
    move(a, 'wei:5,4', 'wei:5,5');
    const s1 = await waitSnapshot(b, (s) => s.game?.ply === 1);
    expect(s1.game.turn === 'shu', '魏走子后回合交给蜀');

    move(b, 'shu:5,4', 'shu:5,5');
    const s2 = await waitSnapshot(c, (s) => s.game?.ply === 2);
    expect(s2.game.turn === 'wu', '蜀走子后回合交给吴');

    move(c, 'wu:5,4', 'wu:5,5');
    const s3 = await waitSnapshot(a, (s) => s.game?.ply === 3);
    expect(s3.game.turn === 'wei', '吴走子后回合回到魏（一圈闭合）');
    expect(s3.game.history.length === 3, '行棋记录累积 3 条');

    // 被将军 / 客户端事件推送
    const gotEvents = a.inbox.some((m) => m.type === 'events');
    expect(gotEvents, '客户端收到事件推送（非仅快照）');

    // 观战者只读
    const watcher = await connect('观众');
    const ws = await waitSnapshot(watcher, () => true);
    expect(ws.spectatorCount >= 1, '观战者进入房间并被计数');
    expect(
      ws.players.find((p: any) => p.nickname === '观众')?.seat === null,
      '观战者没有座位',
    );
    move(watcher, 'wei:1,1', 'wei:1,2');
    const err = await waitReply(watcher, (m) => m.type === 'error');
    expect(
      err?.code === 'notSeated' || err?.code === 'loginRequired',
      `观战者走子被拒绝（${err?.code ?? '无错误回复'}）`,
    );
    watcher.socket.close();

    // 认输流程
    b.socket.emit('msg', { type: 'resign' });
    const s4 = await waitSnapshot(a, (s) => s.game?.status?.shu === 'resigned');
    expect(s4.status === 'playing', '一家认输后对局继续（还剩两家）');
    c.socket.emit('msg', { type: 'resign' });
    const s5 = await waitSnapshot(a, (s) => s.status === 'finished');
    expect(s5.game.winner === 'wei', '两家出局后魏获胜');
  } finally {
    for (const cl of clients) cl.socket.close();
  }

  console.log('\n=== 验证结果 ===');
  for (const r of results) console.log('  ' + r);
  const failed = results.filter((r) => r.startsWith('✘')).length;
  console.log(failed === 0 ? '\n✅ 公网端到端全部通过' : `\n❌ 有 ${failed} 项失败`);
}

main().catch((e) => {
  console.error('公网验证失败:', e.message);
  process.exit(1);
});
