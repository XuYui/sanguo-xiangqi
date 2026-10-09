/**
 * 房间引擎测试
 *
 * 覆盖：加入/重连、手动占座与开局、观战、回合校验、版本冲突重同步、
 * 认输、断线重连、房间回收。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRoom, createRoomManager, randomRoomCode, SEAT_TO_PLAYER, type ClientMsg, type Outbound, type RoomChannel } from '../src/room.ts';

/** 测试用驱动器：把 Outbound 里的回复按客户端ID收集起来 */
class Harness {
  readonly room: RoomChannel;
  /** clientId -> 收到的回复 */
  readonly inbox = new Map<string, unknown[]>();
  /** 广播记录 */
  readonly broadcasts: unknown[] = [];

  constructor(room: RoomChannel) {
    this.room = room;
  }

  private record(out: Outbound, clientId: string | null): void {
    if (clientId) {
      const box = this.inbox.get(clientId) ?? [];
      box.push(...out.replies);
      this.inbox.set(clientId, box);
    }
    this.broadcasts.push(...out.broadcasts);
  }

  send(clientId: string | null, msg: ClientMsg): Outbound {
    const out = this.room.handle(clientId, msg);
    this.record(out, clientId);
    return out;
  }

  lastReply<T = any>(clientId: string, type?: string): T | undefined {
    const box = this.inbox.get(clientId) ?? [];
    const filtered = type ? box.filter((m: any) => m.type === type) : box;
    return filtered.at(-1) as T | undefined;
  }

  lastBroadcast<T = any>(type: string): T | undefined {
    return this.broadcasts.filter((m: any) => m.type === type).at(-1) as T | undefined;
  }

  snapshot(): any {
    return this.lastBroadcast('snapshot')?.snapshot ?? this.room.snapshot();
  }
}

function newHarness(): Harness {
  return new Harness(createRoom({ code: 'TEST', now: () => 1000 }));
}

/**
 * 加入三名玩家并各自选一个势力。
 *
 * 注意：进房**不会**自动占座（势力由玩家自己挑），
 * 所以这里必须显式 takeSeat；最后一位落座时才自动开局。
 */
function joinThree(h: Harness): [string, string, string] {
  const ids = ['c1', 'c2', 'c3'];
  for (const id of ids) {
    h.send(id, { type: 'join', nickname: id });
  }
  ids.forEach((id, i) => h.send(id, { type: 'takeSeat', seat: i as 0 | 1 | 2 }));
  return ids as [string, string, string];
}

// ---------------------------------------------------------------------------
// 加入 / 座位 / 开局
// ---------------------------------------------------------------------------

test('加入房间：发放 clientId + token，并回报快照', () => {
  const h = newHarness();
  const out = h.send('c1', { type: 'join', nickname: '张三' });
  const welcome = out.replies[0] as any;
  assert.equal(welcome.type, 'welcome');
  assert.equal(welcome.clientId, 'c1');
  assert.ok(typeof welcome.token === 'string' && welcome.token.length >= 16);
  assert.equal(welcome.snapshot.code, 'TEST');
  assert.equal(welcome.snapshot.status, 'lobby');
  // 进房**不自动占座**：势力由玩家自己挑（原来会自动给 0 号座）
  assert.equal(welcome.snapshot.players.length, 1);
  assert.equal(welcome.snapshot.players[0].seat, null);
  assert.equal(welcome.snapshot.players[0].nickname, '张三');
  // ready = 已落座且在线；还没选势力所以不算就绪
  assert.equal(welcome.snapshot.players[0].ready, false);
  // 自己选一个势力后才会落座并变为就绪
  h.send('c1', { type: 'takeSeat', seat: 1 });
  const after = h.snapshot();
  assert.equal(after.players[0].seat, 1);
  assert.equal(after.players[0].ready, true);
});

test('加入房间：同一连接不能重复加入', () => {
  const h = newHarness();
  h.send('c1', { type: 'join', nickname: 'a' });
  const out = h.send('c1', { type: 'join', nickname: 'b' });
  assert.equal((out.replies[0] as any).type, 'error');
});

test('断线后稳定成员标识可以恢复原成员', () => {
  const h = newHarness();
  h.send('42', { type: 'join', nickname: '旧昵称' });
  h.room.disconnect('42');
  const out = h.send('42', { type: 'join', nickname: '新昵称' });
  const welcome = out.replies[0] as any;
  assert.equal(welcome.type, 'welcome');
  assert.equal(welcome.clientId, '42');
  assert.equal(welcome.snapshot.players.length, 1);
  assert.equal(welcome.snapshot.players[0].nickname, '新昵称');
  assert.equal(welcome.snapshot.players[0].online, true);
});

test('三人到齐自动开局，座位按 0/1/2 = 魏/蜀/吴 固定映射', () => {
  const h = newHarness();
  joinThree(h);
  const snap = h.snapshot();
  assert.equal(snap.status, 'playing');
  assert.equal(snap.game.turn, 'wei');
  assert.equal(snap.game.pieces['wei:5,4'].kind, 'soldier');
  assert.deepEqual(
    snap.players.map((p: any) => p.seat),
    [0, 1, 2],
  );
  assert.deepEqual(SEAT_TO_PLAYER, { 0: 'wei', 1: 'shu', 2: 'wu' });
  // 开局广播里应有 gameStarted 事件
  assert.ok(
    h.broadcasts.some(
      (b: any) => b.type === 'events' && b.events.some((e: any) => e.type === 'gameStarted'),
    ),
  );
});

test('第四个人加入后只能是观战者（没有座位）', () => {
  const h = newHarness();
  joinThree(h);
  const out = h.send('c4', { type: 'join', nickname: '观众' });
  const welcome = out.replies[0] as any;
  assert.equal(welcome.snapshot.players.find((p: any) => p.clientId === 'c4').seat, null);
  assert.equal(welcome.snapshot.spectatorCount, 1);
});

test('观战者不能走子，也不能认输', () => {
  const h = newHarness();
  joinThree(h);
  h.send('c4', { type: 'join', nickname: '观众' });
  assert.equal((h.send('c4', { type: 'move', from: 'wei:5,4', to: 'wei:5,5', version: 0 }).replies[0] as any).code, 'notSeated');
  assert.equal((h.send('c4', { type: 'resign' }).replies[0] as any).code, 'notSeated');
});

test('开局前可以手动占座 / 离座', () => {
  const h = newHarness();
  h.send('c1', { type: 'join', nickname: 'a' });
  h.send('c2', { type: 'join', nickname: 'b' });
  // c2 想换到 2 号座
  const out = h.send('c2', { type: 'takeSeat', seat: 2 });
  const snap = (out.broadcasts[0] as any).snapshot;
  assert.equal(snap.players.find((p: any) => p.clientId === 'c2').seat, 2);
  // 离座
  const out2 = h.send('c2', { type: 'leaveSeat' });
  const snap2 = (out2.broadcasts[0] as any).snapshot;
  assert.equal(snap2.players.find((p: any) => p.clientId === 'c2').seat, null);
  assert.equal(snap2.status, 'lobby');
});

test('占座冲突与非法座位号被拒绝', () => {
  const h = newHarness();
  h.send('c1', { type: 'join', nickname: 'a' });
  h.send('c2', { type: 'join', nickname: 'b' });
  // c1 先选了 0 号座（魏），c2 再抢同一个座位就会被拒
  assert.equal(h.send('c1', { type: 'takeSeat', seat: 0 }).replies.length, 0);
  assert.equal((h.send('c2', { type: 'takeSeat', seat: 0 }).replies[0] as any).code, 'seatTaken');
  assert.equal((h.send('c2', { type: 'takeSeat', seat: 9 as never }).replies[0] as any).code, 'badSeat');
  // 换到空座位是允许的（开局前可自由选势力）；成功时返回广播快照，没有定向回复
  const moved = h.send('c2', { type: 'takeSeat', seat: 2 });
  assert.equal(moved.replies.length, 0);
  assert.equal((moved.broadcasts[0] as any).type, 'snapshot');
  assert.equal(h.snapshot().players.find((p: { nickname: string }) => p.nickname === 'b').seat, 2);
});

test('未加入房间的连接发消息会被拒绝', () => {
  const h = newHarness();
  assert.equal((h.send('ghost', { type: 'move', from: 'wei:5,4', to: 'wei:5,5', version: 0 }).replies[0] as any).code, 'notJoined');
  assert.equal((h.send('ghost', { type: 'takeSeat', seat: 0 }).replies[0] as any).code, 'notJoined');
});

// ---------------------------------------------------------------------------
// 走子
// ---------------------------------------------------------------------------

test('走子：只有轮到的一方可以走，且回合正确轮转', () => {
  const h = newHarness();
  joinThree(h);
  // 现在是魏（c1）
  let v = h.snapshot().version;
  let out = h.send('c1', { type: 'move', from: 'wei:5,4', to: 'wei:5,5', version: v });
  assert.equal(out.replies.length, 0, '合法走子不该有错误回复');
  assert.equal(h.snapshot().game.turn, 'shu');

  // 轮到蜀了，魏再走应被拒绝
  v = h.snapshot().version;
  const bad = h.send('c1', { type: 'move', from: 'wei:5,5', to: 'wei:5,4', version: v });
  assert.equal((bad.replies[0] as any).code, 'notYourTurn');
});

test('走子：非法走法被拒绝并给出原因', () => {
  const h = newHarness();
  joinThree(h);
  const v = h.snapshot().version;
  const out = h.send('c1', { type: 'move', from: 'wei:1,1', to: 'wei:5,5', version: v });
  const reply = out.replies[0] as any;
  assert.equal(reply.type, 'error');
  assert.equal(reply.code, 'illegalMove');
  assert.ok(reply.message.includes('走法规则'));
});

test('走子：版本号过期时回送最新快照（客户端重同步）', () => {
  const h = newHarness();
  joinThree(h);
  const out = h.send('c1', { type: 'move', from: 'wei:5,4', to: 'wei:5,5', version: 0 });
  assert.equal((out.replies[0] as any).code, 'staleVersion');
  assert.equal((out.replies[1] as any).type, 'welcome');
  assert.equal((out.replies[1] as any).snapshot.game.ply, 0, '快照应是未走子状态');
});

test('走子：吃子与事件会广播给所有人', () => {
  const h = newHarness();
  joinThree(h);
  // 让魏車过河吃蜀兵需要多步，这里用「兵前进」验证事件广播
  const v = h.snapshot().version;
  h.send('c1', { type: 'move', from: 'wei:5,4', to: 'wei:5,5', version: v });
  const evt = h.broadcasts.filter((b: any) => b.type === 'events').at(-1) as any;
  assert.ok(evt.events.some((e: any) => e.type === 'move'));
});

test('requestLegalMoves：返回指定点位的合法落点', () => {
  const h = newHarness();
  joinThree(h);
  const out = h.send('c1', { type: 'requestLegalMoves', from: 'wei:5,4' });
  const payload = (out.replies[0] as any).payload;
  assert.equal(payload.from, 'wei:5,4');
  assert.deepEqual(payload.moves.map((m: any) => `${m.to.file},${m.to.rank}`), ['5,5']);
  assert.equal(payload.moves[0].capture, false);
});

// ---------------------------------------------------------------------------
// 认输 / 结束
// ---------------------------------------------------------------------------

test('认输：广播事件且对局结束，胜者产生', () => {
  const h = newHarness();
  joinThree(h);
  h.send('c2', { type: 'resign' }); // 蜀认输
  h.send('c3', { type: 'resign' }); // 吴认输
  const snap = h.snapshot();
  assert.equal(snap.status, 'finished');
  assert.equal(snap.game.phase, 'finished');
  assert.equal(snap.game.winner, 'wei');
  const evt = h.broadcasts.filter((b: any) => b.type === 'events').at(-1) as any;
  assert.ok(evt.events.some((e: any) => e.type === 'gameOver'));
});

test('对局结束后不能再走子', () => {
  const h = newHarness();
  joinThree(h);
  h.send('c2', { type: 'resign' });
  h.send('c3', { type: 'resign' });
  const v = h.snapshot().version;
  const out = h.send('c1', { type: 'move', from: 'wei:5,4', to: 'wei:5,5', version: v });
  assert.equal((out.replies[0] as any).code, 'finished');
});

// ---------------------------------------------------------------------------
// 断线重连 / 观战 / 聊天
// ---------------------------------------------------------------------------

test('断线重连：凭 token 回到原座位与昵称', () => {
  const h = newHarness();
  joinThree(h);
  const token = h.lastReply<any>('c1', 'welcome').token;
  // 断线
  const d = h.room.disconnect('c1');
  assert.ok((d.broadcasts[0] as any).snapshot.players.find((p: any) => p.clientId === 'c1').online === false);
  // 用新连接 + token 重连
  const out = h.send('c1-new', { type: 'join', nickname: '张三', token });
  const welcome = out.replies[0] as any;
  assert.equal(welcome.type, 'welcome');
  assert.equal(welcome.clientId, 'c1', '应恢复原 clientId');
  assert.equal(welcome.snapshot.players.find((p: any) => p.clientId === 'c1').online, true);
  assert.equal(welcome.snapshot.game.turn, 'wei', '对局状态不丢');
});

test('断线重连：错误 token 会当新人处理', () => {
  const h = newHarness();
  joinThree(h);
  const out = h.send('c9', { type: 'join', nickname: '冒名', token: 'deadbeef' });
  const welcome = out.replies[0] as any;
  assert.equal(welcome.clientId, 'c9', '应作为新客户端');
  assert.equal(welcome.snapshot.players.find((p: any) => p.clientId === 'c9').seat, null, '开局后加入只能观战');
});

test('聊天：广播给房间，带昵称与座位', () => {
  const h = newHarness();
  joinThree(h);
  h.send('c1', { type: 'chat', text: '  大家好  ' });
  const chat = h.broadcasts.filter((b: any) => b.type === 'chat').at(-1) as any;
  assert.equal(chat.text, '大家好');
  assert.equal(chat.from, 'c1');
  assert.equal(chat.seat, 0);
  // 空消息不广播
  const before = h.broadcasts.length;
  h.send('c1', { type: 'chat', text: '   ' });
  assert.equal(h.broadcasts.length, before);
});

test('ping -> pong', () => {
  const h = newHarness();
  h.send('c1', { type: 'join', nickname: 'a' });
  const out = h.send('c1', { type: 'ping' });
  assert.equal((out.replies[0] as any).type, 'pong');
});

// ---------------------------------------------------------------------------
// 房间管理器
// ---------------------------------------------------------------------------

test('房间码：只含不易混淆的字符，长度可控', () => {
  for (let i = 0; i < 50; i++) {
    const code = randomRoomCode(4);
    assert.equal(code.length, 4);
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}$/);
  }
});

test('房间管理器：创建 / 查询 / 回收空房', () => {
  const mgr = createRoomManager();
  const room = mgr.create({ code: 'ABCD' });
  assert.equal(mgr.get('ABCD'), room);
  assert.equal(mgr.get('abcd'), room, '查询应大小写不敏感');
  assert.equal(mgr.rooms.size, 1);
  assert.deepEqual(mgr.gc(), ['ABCD'], '空房应被回收');
  assert.equal(mgr.rooms.size, 0);
});

test('房间管理器：码冲突时自动换码', () => {
  const mgr = createRoomManager();
  mgr.create({ code: 'SAME' });
  const second = mgr.create({ code: 'SAME' });
  assert.notEqual(second.code, 'SAME');
});

test('房间快照可 JSON 往返（要发给浏览器）', () => {
  const h = newHarness();
  joinThree(h);
  const snap = h.snapshot();
  const back = JSON.parse(JSON.stringify(snap));
  assert.equal(back.status, 'playing');
  assert.equal(Object.keys(back.game.pieces).length, 48);
  assert.equal(back.version, snap.version);
});
