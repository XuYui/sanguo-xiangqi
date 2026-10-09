/**
 * 账号与存储层测试。
 *
 * 用真实 SQLite（`:memory:`，由 node:sqlite 提供）跑，不引入第三方依赖。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthService, SESSION_TTL_MS, hashPassword, verifyPassword } from '../src/auth.ts';
import { SqliteStore } from '../src/sqlite-store.ts';
import { MIN_PASSWORD_LENGTH } from '../src/store.ts';

function fresh(): { store: SqliteStore; auth: AuthService } {
  const store = new SqliteStore(':memory:');
  return { store, auth: new AuthService(store) };
}

// ---------------------------------------------------------------------------
// 密码哈希
// ---------------------------------------------------------------------------

test('密码哈希：同一密码同一盐结果一致，不同盐不同', () => {
  const a = hashPassword('hunter2');
  const b = hashPassword('hunter2', a.salt);
  assert.equal(a.hash, b.hash);
  const c = hashPassword('hunter2');
  assert.notEqual(a.hash, c.hash, '不同盐应得到不同哈希');
  assert.equal(a.salt.length, 32);
  assert.equal(a.hash.length, 128); // 64 字节 → 128 hex
});

test('密码校验：正确通过、错误拒绝、长度不符也不崩', () => {
  const { hash, salt } = hashPassword('correct horse');
  assert.ok(verifyPassword('correct horse', hash, salt));
  assert.ok(!verifyPassword('wrong horse', hash, salt));
  assert.ok(!verifyPassword('', hash, salt));
  // 哈希串被截断时要安全返回 false 而不是抛异常
  assert.ok(!verifyPassword('correct horse', hash.slice(0, 10), salt));
});

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

test('注册：成功后可登录，返回会话令牌与账号信息', () => {
  const { auth } = fresh();
  const r = auth.register('alice', 'secret123', '爱丽丝');
  assert.ok(r.ok, '注册应成功：' + (r.error ?? ''));
  const v = r.value!;
  assert.equal(v.account.username, 'alice');
  assert.equal(v.account.nickname, '爱丽丝');
  assert.equal(v.token.length, 64); // 32 字节 hex
  assert.ok(v.expiresAt > Date.now());
  assert.ok(v.expiresAt - Date.now() <= SESSION_TTL_MS + 1000);
  assert.equal(auth.verify(v.token)?.username, 'alice');
});

test('注册：用户名格式校验', () => {
  const { auth } = fresh();
  for (const bad of ['', 'ab', 'a'.repeat(17), '有中文', 'with space', 'with-dash', 'a@b'] as const) {
    const r = auth.register(bad, 'secret123');
    assert.ok(!r.ok, `「${bad}」不该通过`);
    assert.equal(r.errorCode, 'badUsername');
  }
  assert.ok(auth.register('ok_name123', 'secret123').ok);
});

test('注册：密码长度校验', () => {
  const { auth } = fresh();
  const r = auth.register('bob', 'x'.repeat(MIN_PASSWORD_LENGTH - 1));
  assert.ok(!r.ok);
  assert.equal(r.errorCode, 'badPassword');
  assert.ok(auth.register('bob', 'x'.repeat(MIN_PASSWORD_LENGTH)).ok);
});

test('注册：用户名唯一（重复注册被拒）', () => {
  const { auth } = fresh();
  assert.ok(auth.register('alice', 'secret123').ok);
  const dup = auth.register('alice', 'another123');
  assert.ok(!dup.ok);
  assert.equal(dup.errorCode, 'usernameTaken');
});

test('注册：未填昵称时用用户名兜底', () => {
  const { auth } = fresh();
  const r = auth.register('carol', 'secret123');
  assert.equal(r.value?.account.nickname, 'carol');
});

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

test('登录：密码正确返回新令牌；旧令牌仍有效（多端登录）', () => {
  const { auth } = fresh();
  const reg = auth.register('alice', 'secret123');
  const login = auth.login('alice', 'secret123');
  assert.ok(login.ok, '登录应成功：' + (login.error ?? ''));
  assert.notEqual(login.value!.token, reg.value!.token, '每次登录应发新令牌');
  assert.ok(auth.verify(reg.value!.token), '旧会话不该被踢掉');
  assert.ok(auth.verify(login.value!.token));
});

test('登录：密码错误与用户不存在返回同一个错误（防账号枚举）', () => {
  const { auth } = fresh();
  auth.register('alice', 'secret123');
  const wrongPass = auth.login('alice', 'nope12345');
  const noUser = auth.login('nobody', 'nope12345');
  assert.ok(!wrongPass.ok && !noUser.ok);
  assert.equal(wrongPass.errorCode, 'badCredentials');
  assert.equal(noUser.errorCode, 'badCredentials');
  assert.equal(wrongPass.error, noUser.error);
});

test('登录：用户名大小写敏感', () => {
  const { auth } = fresh();
  auth.register('Alice', 'secret123');
  assert.ok(auth.login('Alice', 'secret123').ok);
  assert.ok(!auth.login('alice', 'secret123').ok);
});

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

test('会话：未知令牌返回 null，登出后失效', () => {
  const { auth } = fresh();
  assert.equal(auth.verify('nonexistent'), null);
  assert.equal(auth.verify(null), null);
  assert.equal(auth.verify(undefined), null);
  const r = auth.register('alice', 'secret123');
  const token = r.value!.token;
  assert.ok(auth.verify(token));
  auth.logout(token);
  assert.equal(auth.verify(token), null);
});

test('会话：过期后失效并被清理', () => {
  const store = new SqliteStore(':memory:');
  let now = 1_000_000;
  const auth = new AuthService(store, () => now);
  const r = auth.register('alice', 'secret123');
  const token = r.value!.token;
  assert.ok(auth.verify(token));
  now += SESSION_TTL_MS + 1; // 时间推进到过期之后
  assert.equal(auth.verify(token), null, '过期会话不该通过');
  assert.equal(store.findSession(token), null, '过期会话应被删除');
});

test('会话：purgeExpired 只清理过期的', () => {
  const store = new SqliteStore(':memory:');
  let now = 1000;
  const auth = new AuthService(store, () => now);
  const a = auth.register('alice', 'secret123').value!.token;
  now += 10;
  const b = auth.register('bob', 'secret123').value!.token;
  // 把 a 改成已过期
  const sa = store.findSession(a)!;
  store.createSession(a, sa.accountId, sa.createdAt, now - 1);
  assert.equal(auth.purgeExpired(), 1);
  assert.equal(store.findSession(a), null);
  assert.ok(store.findSession(b));
});

// ---------------------------------------------------------------------------
// 房间落座持久化
// ---------------------------------------------------------------------------

test('落座记录：同一账号在同一房间只保留一条，可换座', () => {
  const { store } = fresh();
  const acc = store.createAccount('alice', '爱丽丝', 'h', 's')!;
  store.upsertSeat({ code: 'ROOM1', accountId: acc.id, seat: 0, nickname: '爱丽丝', joinedAt: 1 });
  store.upsertSeat({ code: 'ROOM1', accountId: acc.id, seat: 2, nickname: '爱丽丝', joinedAt: 2 });
  const seats = store.seatsOfRoom('ROOM1');
  assert.equal(seats.length, 1);
  assert.equal(seats[0]!.seat, 2);
  assert.equal(store.roomsOfAccount(acc.id).length, 1);
});

test('落座记录：可以记录「已进房但未落座」（观战）', () => {
  const { store } = fresh();
  const acc = store.createAccount('alice', '爱丽丝', 'h', 's')!;
  store.upsertSeat({ code: 'ROOM1', accountId: acc.id, seat: null, nickname: '爱丽丝', joinedAt: 1 });
  assert.equal(store.seatsOfRoom('ROOM1')[0]!.seat, null);
});

test('落座记录：删除账号时级联清理（外键约束）', () => {
  const { store } = fresh();
  const acc = store.createAccount('alice', '爱丽丝', 'h', 's')!;
  store.upsertSeat({ code: 'ROOM1', accountId: acc.id, seat: 0, nickname: '爱丽丝', joinedAt: 1 });
  store.deleteSeat('ROOM1', acc.id);
  assert.equal(store.seatsOfRoom('ROOM1').length, 0);
});

// ---------------------------------------------------------------------------
// 对局持久化
// ---------------------------------------------------------------------------

test('对局：保存 → 读回 → 覆盖，未结束列表只含进行中的', () => {
  const { store } = fresh();
  store.saveGame({ code: 'R1', status: 'playing', gameJson: '{"turn":"wei"}', version: 3, updatedAt: 100 });
  store.saveGame({ code: 'R2', status: 'playing', gameJson: '{"turn":"shu"}', version: 5, updatedAt: 200 });
  store.saveGame({ code: 'R3', status: 'finished', gameJson: '{}', version: 9, updatedAt: 300 });
  assert.equal(store.loadGame('R1')?.version, 3);
  assert.deepEqual(store.listLiveGames().map((g) => g.code), ['R2', 'R1'], '按更新时间倒序');
  // 覆盖同一房间
  store.saveGame({ code: 'R1', status: 'finished', gameJson: '{}', version: 4, updatedAt: 400 });
  assert.equal(store.loadGame('R1')?.status, 'finished');
  assert.deepEqual(store.listLiveGames().map((g) => g.code), ['R2']);
  store.deleteGame('R2');
  assert.equal(store.loadGame('R2'), null);
});

test('持久化：关库重开后数据仍在（模拟服务重启）', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sanguo-store-'));
  const file = join(dir, 'auth.db');
  try {
    const s1 = new SqliteStore(file);
    const auth1 = new AuthService(s1);
    const r = auth1.register('alice', 'secret123', '爱丽丝').value!;
    s1.upsertSeat({ code: 'ROOM9', accountId: r.account.id, seat: 1, nickname: '爱丽丝', joinedAt: 1 });
    s1.saveGame({ code: 'ROOM9', status: 'playing', gameJson: '{"turn":"shu"}', version: 12, updatedAt: 1 });
    s1.close();

    const s2 = new SqliteStore(file);
    const auth2 = new AuthService(s2);
    assert.ok(auth2.verify(r.token), '重启后会话仍有效');
    assert.equal(auth2.login('alice', 'secret123').value?.account.nickname, '爱丽丝');
    assert.equal(s2.seatsOfRoom('ROOM9')[0]!.seat, 1, '重启后落座记录还在');
    assert.equal(s2.loadGame('ROOM9')?.version, 12, '重启后对局还在');
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
