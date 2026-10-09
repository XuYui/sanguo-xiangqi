/** Socket 重建后的房间频道回归测试。 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const storage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
(globalThis as any).localStorage = storage;

class FakeSocket {
  connected = false;
  readonly io = {
    on: (_name: string, _fn: (...args: any[]) => void) => this.io,
  };
  readonly emitted: { name: string; payload: any }[] = [];
  private readonly handlers = new Map<string, ((...args: any[]) => void)[]>();

  on(name: string, fn: (...args: any[]) => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
    return this;
  }

  once(name: string, fn: (...args: any[]) => void) {
    const once = (...args: any[]) => {
      this.off(name, once);
      fn(...args);
    };
    return this.on(name, once);
  }

  off(name: string, fn: (...args: any[]) => void) {
    this.handlers.set(name, (this.handlers.get(name) ?? []).filter((h) => h !== fn));
  }

  removeAllListeners() {
    this.handlers.clear();
    return this;
  }

  disconnect() {
    this.connected = false;
    return this;
  }

  emit(name: string, payload: any, ack?: (value: any) => void) {
    this.emitted.push({ name, payload });
    if (name === 'joinRoom') queueMicrotask(() => ack?.({ ok: true, code: payload.code }));
    return this;
  }

  trigger(name: string, ...args: any[]) {
    if (name === 'connect') this.connected = true;
    for (const fn of [...(this.handlers.get(name) ?? [])]) fn(...args);
  }
}

const sockets: FakeSocket[] = [];
(globalThis as any).window = {
  io: () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  },
};

const { Channel } = await import('../../web/public/app/net.js');

test('重建 socket 后会重新加入当前房间', async () => {
  const channel = new Channel();
  channel.code = 'ROOM';

  const pending = channel.reconnectWithToken();
  const socket = sockets.at(-1)!;
  socket.trigger('connect');
  await pending;

  assert.deepEqual(
    socket.emitted.filter((e) => e.name === 'joinRoom').map((e) => e.payload.code),
    ['ROOM'],
  );
});
