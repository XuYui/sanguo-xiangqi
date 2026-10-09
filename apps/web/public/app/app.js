/**
 * 应用主控制器：把「通道 / 棋盘视图 / 面板」接起来
 *
 * 数据流是单向的：
 *   服务端广播 snapshot → 存下来 → render() → 更新棋盘与面板
 *   用户点击 → 发消息给服务端 → 等服务端广播回来才改本地状态
 * 本地只保留两种「暂时性」状态：选中了哪个点、该点有哪些可走点（由服务端算）。
 */

import { BoardView } from './board-view.js?v=20261009-oss1';
import { Channel, account } from './net.js?v=20261009-oss1';
import {
  bannerFor,
  playerName,
  renderCaptured,
  renderChat,
  renderRoster,
} from './panels.js?v=20261009-oss1';
import { loadBaseSvg, loadGeometry } from './render.js?v=20261009-oss1';

const NICK_KEY = 'sanguo.nickname';

/** @type {any} */
let snapshot = null;

const el = (id) => document.getElementById(id);

function setText(id, text) {
  const node = el(id);
  if (node && node.textContent !== text) node.textContent = text;
}

/**
 * 解析一次棋盘点击应该做什么。
 *
 * 抽成纯函数（不碰 DOM），这样交互逻辑可以单元测试覆盖，
 * 也能被浏览器里的自检钩子直接调用，不必依赖屏幕坐标换算。
 *
 * @param {{pieces: Record<string, {owner:string}>}|null} game
 * @param {string|null} myPlayer
 * @param {string|null} selected
 * @param {readonly {to:{player:string,file:number,rank:number}}[]} targets
 * @param {string} pointId
 * @returns {{kind:'move', to:string} | {kind:'select', from:string} | {kind:'clear'} | {kind:'ignore', reason:string}}
 */
export function resolveBoardClick(game, myPlayer, selected, targets, pointId) {
  if (!game || game.phase !== 'playing') return { kind: 'ignore', reason: 'notPlaying' };
  if (game.turn !== myPlayer) return { kind: 'ignore', reason: 'notYourTurn' };

  const hit = targets.find(
    (t) => `${t.to.player}:${t.to.file},${t.to.rank}` === pointId,
  );
  if (hit && selected) return { kind: 'move', to: pointId };

  const piece = game.pieces[pointId];
  if (piece && piece.owner === myPlayer) return { kind: 'select', from: pointId };

  return { kind: 'clear' };
}

/**
 * 判断是否应采纳服务端快照。
 * 同一房间的消息可能因传输时序晚到，旧快照不能覆盖已经看到的新回合；
 * 换房间时则按房间码重新建立版本序列。
 */
export function shouldAcceptSnapshot(current, next) {
  if (!next) return false;
  if (!current || current.code !== next.code) return true;
  return next.version > current.version;
}

async function main() {
  // ---------------------------------------------------------------------
  // 载入资源
  // ---------------------------------------------------------------------
  const [geom, baseSvgText] = await Promise.all([
    loadGeometry('board-geometry.json?v=20261009-oss1'),
    loadBaseSvg('board-plain.svg?v=20261009-oss1'),
  ]);

  const channel = new Channel();
  const view = new BoardView(el('board'), geom, baseSvgText);

  /** 本地暂态 */
  let selected = null;
  let targets = [];
  let myPlayer = null;
  let mySeat = null;
  let lastMove = null;
  // ---------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------
  function render() {
    const game = snapshot?.game ?? null;
    const checkedIds = [];
    for (const k of snapshot?.checkedPlayers ?? []) {
      const id = `${k}:5,1`;
      if (game?.pieces?.[id]?.kind === 'general') checkedIds.push(id);
    }

    view.render(game, { myPlayer, checkIds: checkedIds, lastMove });

    const banner = bannerFor(snapshot ?? { players: [], game: null }, myPlayer);
    const bannerNode = el('banner');
    bannerNode.textContent = banner?.text ?? '';
    bannerNode.className = `banner kind-${banner?.kind ?? 'wait'}`;

    setText('room-code', snapshot?.code ?? '——');

    el('roster').replaceChildren(
      renderRoster(snapshot ?? { players: [], seatPlayers: {}, game: null }, {
    myPlayer,
    mySeat,
    // 点右侧「空位」= 选那个势力（取代原来的底部选势力面板）
    onPickSeat: (seat) => {
      if (!me) {
        openAuth('login');
        return;
      }
      channel.send({ type: 'takeSeat', seat });
    },
  }),
    );
    el('captured').replaceChildren(renderCaptured(snapshot ?? { game: null }));
    el('chat').replaceChildren(renderChat(chatLog));
    el('chat').scrollTop = el('chat').scrollHeight;

    el('btn-resign').disabled = !(game?.phase === 'playing') || mySeat === null;
    el('btn-start').hidden = !(snapshot && !snapshot.game && seatsFilled() && mySeat !== null);
    el('btn-leave-seat').hidden = mySeat === null || !!snapshot?.game;
    el('seat-hint').textContent = seatHint();
    // 未进房时给一句指路提示；进房后隐藏
    el('need-room').hidden = !!snapshot;
  }

  function seatsFilled() {
    if (!snapshot) return false;
    return snapshot.players.filter((p) => p.seat !== null).length === 3;
  }

  function seatHint() {
    if (!snapshot) return '正在连接…';
    if (snapshot.game) return '';
    const taken = snapshot.players.filter((p) => p.seat !== null).length;
    return taken >= 3 ? '三家到齐，正在开局…' : `还差 ${3 - taken} 位玩家`;
  }

  function installSnapshot(next) {
    if (!shouldAcceptSnapshot(snapshot, next)) return false;
    snapshot = next;
    afterSnapshot();
    render();
    return true;
  }

  // ---------------------------------------------------------------------
  // 交互
  // ---------------------------------------------------------------------
  view.onSelect = (pointId) => {
    const action = resolveBoardClick(snapshot?.game ?? null, myPlayer, selected, targets, pointId);
    switch (action.kind) {
      case 'move':
        channel.send({ type: 'move', from: selected, to: action.to, version: snapshot.version });
        selected = null;
        targets = [];
        view.setSelection(null, []);
        break;
      case 'select':
        selected = action.from;
        targets = [];
        view.setSelection(selected, targets);
        channel.send({ type: 'requestLegalMoves', from: action.from });
        break;
      case 'clear':
        selected = null;
        targets = [];
        view.setSelection(null, []);
        break;
      default:
        break; // notYourTurn / notPlaying：保持现状
    }
  };

  /**
   * 自检钩子：把「落点 → 动作」暴露给自动化测试。
   * 这样验证交互不需要依赖屏幕坐标换算（那部分由浏览器与 SVG 负责）。
   */
  window.__sanguo = {
    /** 调试用：暴露通道与账号，便于排查联机问题 */
    channel,
    account,
    /**
     * 当前房间快照的**权威版本号**。
     *
     * 服务端对走子做版本校验（版本不符会回 staleVersion 并补发快照）。
     * 任何脚本化操作都应当用这个值，而不是自己维护一份副本——
     * 否则会出现「一直 staleVersion、回合推不动」。
     */
    version: () => snapshot?.version ?? null,
    /** 模拟点击某个交叉点 */
    click(pointId) {
      view.onSelect(pointId);
      return { selected, targets: targets.map((t) => `${t.to.player}:${t.to.file},${t.to.rank}`) };
    },
    /** 选势力（等价于点选势力卡片） */
    takeSeat(seat) {
      channel.send({ type: 'takeSeat', seat });
    },
    state: () => ({
      myPlayer,
      mySeat,
      selected,
      targets: targets.map((t) => `${t.to.player}:${t.to.file},${t.to.rank}`),
      turn: snapshot?.game?.turn ?? null,
      history: snapshot?.game?.history?.length ?? 0,
      pieces: snapshot?.game ? Object.keys(snapshot.game.pieces).length : 0,
      view: view.view,
    }),
  };

  el('btn-resign').addEventListener('click', () => {
    if (confirm('确定认输吗？你的棋子会被全部移除。')) channel.send({ type: 'resign' });
  });

  el('btn-start').addEventListener('click', () => channel.send({ type: 'requestStart' }));

  // ---------------------------------------------------------------------
  // 房间：创建 / 加入 / 换房间
  // ---------------------------------------------------------------------
  /** 进入某个房间（房间码已确定） */
  async function enterRoom(target) {
    const wanted = target.toUpperCase().trim();
    if (!/^[A-Z0-9]{3,8}$/.test(wanted)) {
      toast('房间码需为 3~8 位字母或数字');
      return;
    }
    const ack = await channel.joinRoom(wanted);
    if (!ack.ok) {
      toast(ack.error ?? '加入房间失败');
      return;
    }
    code = wanted;
    history.replaceState(null, '', `?room=${code}`);
    channel.hello(nickname);
    el('room-actions').hidden = true;
    el('room-panel').hidden = false;
    setText('conn', '已连接');
  }

  el('btn-create-room').addEventListener('click', async () => {
    // 房间码由服务端随机生成（ready 事件里已经给了一个），直接用它创建
    const fresh = channel.serverInfo?.randomCode;
    if (!fresh) {
      toast('还没连上服务器，请稍候');
      return;
    }
    await enterRoom(fresh);
  });

  el('btn-join-room').addEventListener('click', async () => {
    const input = el('join-code');
    const wanted = input.value.trim().toUpperCase();
    if (!wanted) {
      toast('请输入房间码');
      input.focus();
      return;
    }
    await enterRoom(wanted);
  });

  el('join-code').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      el('btn-join-room').click();
    }
  });

  el('btn-leave-room').addEventListener('click', () => {
    // 换房间：清掉房间参数并重新载入（简单可靠，避免残留房间状态）
    location.href = `${location.origin}/`;
  });

  el('btn-copy').addEventListener('click', async () => {
    const code = snapshot?.code;
    if (!code) return;
    const url = `${location.origin}/?room=${code}`;
    try {
      await navigator.clipboard.writeText(url);
      el('btn-copy').textContent = '已复制！';
    } catch {
      el('btn-copy').textContent = url;
    }
    setTimeout(() => setText('btn-copy', '复制邀请链接'), 1600);
  });

  el('chat-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = el('chat-input');
    const text = input.value.trim();
    if (!text) return;
    channel.send({ type: 'chat', text });
    input.value = '';
  });

  el('btn-leave-seat').addEventListener('click', () => {
    channel.send({ type: 'leaveSeat' });
  });

  // ---------------------------------------------------------------------
  // 消息处理
  // ---------------------------------------------------------------------
  const chatLog = [];

  channel.onStatus((s) => {
    setText('conn', s === 'connected' ? '已连接' : '连接中断，正在重连…');
    el('conn').className = s === 'connected' ? 'conn ok' : 'conn bad';
    if (s.startsWith('disconnected') || s.startsWith('error')) {
      selected = null;
      targets = [];
    }
  });

  /**
   * 身份到手时重新推导「我是谁」并立即重绘。
   *
   * 这条回调是竞态的关键补丁：如果快照先于 `joined` 到达，第一帧 myPlayer 会是 null；
   * 等 clientId 到位（或从 localStorage 找回）后立刻修正身份，棋盘马上就能点。
   */
  channel.onClientId(() => {
    if (!snapshot) return;
    const before = `${mySeat}/${myPlayer}`;
    deriveIdentity();
    if (`${mySeat}/${myPlayer}` !== before) render();
  });

  channel.onReply((msg) => {
    if (msg.type === 'welcome') {
      channel.rememberToken(msg.token);
      // welcome 里的 clientId 是**房间成员的权威 id**。
      // 凭 token 重连时它会回带原成员 id（与本次连接的 socket id 不同），
      // 采纳它才能保证刷新后仍然认得出自己。
      channel.setMemberId(msg.clientId);
      installSnapshot(msg.snapshot);
      return;
    }
    if (msg.type === 'error') {
      // 版本过期：服务端紧接着会补一条带最新快照的 `welcome`（见 room.ts）。
      // 这里**不能只弹提示就不管**：此时 selected 还在、targets 已经过期，
      // 玩家再点落点会被一直拒绝，表现就是「棋子点不动」。
      // 正确做法是保留选中、重新拉取合法走法，让玩家可以直接再点一次。
      if (msg.code === 'staleVersion') {
        if (selected) channel.send({ type: 'requestLegalMoves', from: selected });
        return;
      }
      toast(msg.message);
      if (msg.code === 'notYourTurn') {
        selected = null;
        targets = [];
        view.setSelection(null, []);
      }
      return;
    }
    if (msg.type === 'legalMoves') {
      if (msg.payload.from !== selected) return;
      targets = msg.payload.moves;
      view.setSelection(selected, targets);
      return;
    }
  });

  channel.onBroadcast((msg) => {
    if (msg.type === 'snapshot') {
      installSnapshot(msg.snapshot);
      return;
    }
    if (msg.type === 'events') {
      for (const ev of msg.events) handleEvent(ev);
      return;
    }
    if (msg.type === 'chat') {
      chatLog.push({ from: msg.from, text: msg.text, seat: msg.seat });
      el('chat').replaceChildren(renderChat(chatLog));
      el('chat').scrollTop = el('chat').scrollHeight;
    }
  });

  /**
   * 推导「我是谁」。
   *
   * 关键：不能只依赖 channel.clientId —— 房间快照可能**早于** `joined` 事件到达
   * （polling 传输下同一批消息按序返回，这一点尤其明显）。之前正是因为该竞态，
   * myPlayer 停在 null，导致棋盘点击被静默忽略、横幅显示「等待 X 走子」。
   *
   * 现在按可信度依次尝试，且每次都拿快照校验，避免房间被回收重建后认错人：
   *   1. channel.clientId —— 服务端 `joined` 给出的权威成员身份；
   *   2. localStorage 里按房间码记住的 clientId —— 刷新/重连后立刻可用。
   */
  function deriveIdentity() {
    if (!snapshot) return;
    const players = snapshot.players ?? [];
    for (const id of [channel.clientId, channel.rememberedClientId(snapshot.code)]) {
      if (!id) continue;
      const hit = players.find((p) => p.clientId === id);
      if (!hit) continue;
      // 记住的 id 仍有效时同步回 channel，后续走子请求继续用它
      if (id !== channel.clientId) channel.clientId = id;
      mySeat = hit.seat ?? null;
      myPlayer = mySeat === null ? null : (snapshot.seatPlayers?.[mySeat] ?? null);
      return;
    }
    mySeat = null;
    myPlayer = null;
  }

  function afterSnapshot() {
    deriveIdentity();

    // 落子后清掉选中态（走子结果以服务端为准）
    const game = snapshot.game;
    if (game && game.history.length > 0) {
      const last = game.history.at(-1);
      lastMove = { from: `${last.move.from.player}:${last.move.from.file},${last.move.from.rank}`, to: `${last.move.to.player}:${last.move.to.file},${last.move.to.rank}` };
      if (last.by === myPlayer) {
        selected = null;
        targets = [];
        view.setSelection(null, []);
      }
    }
  }

  function handleEvent(ev) {
    if (ev.type === 'check') {
      toast(`${playerName(ev.by)} 将军 ${playerName(ev.victim)}！`);
    } else if (ev.type === 'eliminated') {
      toast(`${playerName(ev.who)} 出局`);
    } else if (ev.type === 'gameOver') {
      toast(ev.winner ? `${playerName(ev.winner)} 获胜！` : '对局结束');
    }
  }

  let toastTimer = null;
  function toast(text) {
    const node = el('toast');
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
  }

  // ---------------------------------------------------------------------
  // 账号：登录 / 注册对话框
  // ---------------------------------------------------------------------
  /** 当前账号（null = 未登录，只能观战） */
  let me = null;
  /** 是否已经决定过「登录还是先观战」——决定过就不再自动弹窗 */
  let authDecided = false;

  function setAuthError(text) {
    const node = el('auth-error');
    node.textContent = text ?? '';
    node.hidden = !text;
  }

  /** 切换「登录 / 注册」两个标签 */
  function setAuthMode(mode) {
    const isRegister = mode === 'register';
    el('tab-login').classList.toggle('active', !isRegister);
    el('tab-register').classList.toggle('active', isRegister);
    el('field-nickname').hidden = !isRegister;
    el('btn-auth-submit').textContent = isRegister ? '注册并进入' : '登录';
    el('auth-password').setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
    setAuthError('');
  }

  function openAuth(mode = 'login') {
    setAuthMode(mode);
    el('auth-modal').hidden = false;
    setTimeout(() => el('auth-username').focus(), 30);
  }

  function closeAuth() {
    el('auth-modal').hidden = true;
    setAuthError('');
  }

  /** 渲染顶栏的账号状态，并按登录与否调整可用的操作 */
  function renderAccount() {
    el('account-guest').hidden = !!me;
    el('account-user').hidden = !me;
    if (me) setText('account-name', me.nickname || me.username);
    // 未登录访客点「空位」时会引导登录；登录状态变化后重绘一次让提示同步
    render();
  }

  /** 登录成功后：刷新账号显示、用账号昵称重新报到、并关闭对话框 */
  async function afterAuth(accountInfo) {
    me = accountInfo;
    authDecided = true;
    nickname = accountInfo.nickname || accountInfo.username;
    localStorage.setItem(NICK_KEY, nickname);
    renderAccount();
    closeAuth();
    // reconnectWithToken 已重新加入当前房间，再用账号身份报到，服务端才能还原原座位
    if (channel.code) channel.hello(nickname);
    toast(`欢迎，${nickname}`);
  }

  el('btn-open-auth').addEventListener('click', () => openAuth('login'));
  el('tab-login').addEventListener('click', () => setAuthMode('login'));
  el('tab-register').addEventListener('click', () => setAuthMode('register'));
  el('auth-mask').addEventListener('click', closeAuth);
  el('btn-auth-skip').addEventListener('click', () => {
    authDecided = true;
    closeAuth();
  });

  el('auth-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const username = el('auth-username').value.trim();
    const password = el('auth-password').value;
    const nicknameInput = el('auth-nickname').value.trim();
    const isRegister = el('tab-register').classList.contains('active');
    const submit = el('btn-auth-submit');
    submit.disabled = true;
    setAuthError('');
    try {
      const res = isRegister
        ? await account.register(username, password, nicknameInput)
        : await account.login(username, password);
      if (!res.ok) {
        setAuthError(res.error ?? '操作失败，请重试');
        return;
      }
      // 令牌已由 account 存好。注意：Socket.IO 的 auth 只在**创建 socket**时读取，
      // 所以必须重建连接（不能只 disconnect+connect），否则服务端仍把我们当访客。
      // 登录前的房间 token / clientId 属于游客，不能带到账号连接上。
      channel.forgetToken();
      channel.forgetIdentity();
      await channel.reconnectWithToken();
      await afterAuth(res.account);
    } finally {
      submit.disabled = false;
    }
  });

  el('btn-logout').addEventListener('click', async () => {
    await account.logout();
    me = null;
    renderAccount();
    channel.forgetToken();
    channel.forgetIdentity();
    // 同样要重建连接，才能丢掉旧令牌（否则服务端仍认旧账号）
    await channel.reconnectWithToken();
    if (channel.code) channel.hello(nickname);
    toast('已退出登录，当前为观战模式');
  });

  // ---------------------------------------------------------------------
  // 启动：连服务器 → 进房间 → 报昵称
  // ---------------------------------------------------------------------
  channel.connect();

  const params = new URLSearchParams(location.search);
  /** 支持 ?room=ABCD&name=张三 直接开局（方便分享与自动化截图） */
  let code = (params.get('room') ?? '').toUpperCase();
  let nickname = (params.get('name') ?? localStorage.getItem(NICK_KEY) ?? '').trim();
  const boot = async () => {
    // 先解析账号：令牌有效就用账号昵称，无效则清掉
    me = await account.me();
    renderAccount();
    if (me) {
      nickname = nickname || me.nickname || me.username;
      localStorage.setItem(NICK_KEY, nickname);
    } else if (!authDecided) {
      // 未登录：主动请他登录，这样才有账号身份能记住座位。
      // 从邀请链接（带 ?room=）进来时同样要弹——否则会以游客身份进来，
      // 等点「坐下参战」才发现要登录，体验更差。
      // 只想看棋的可以直接点「先观战」。
      openAuth('login');
    }

    if (!nickname) {
      nickname = me?.nickname || (me ? me.username : '');
    }
    if (!nickname) {
      nickname = `观战者${Math.floor(Math.random() * 900 + 100)}`;
      localStorage.setItem(NICK_KEY, nickname);
    }
    // 没有 ?room= 就等用户点「创建房间」或「加入房间」——
    // 不再用 prompt 询问，也不再自动进入一个房间。
    if (!code) {
      el('need-room').hidden = false;
      return;
    }
    const ack = await channel.joinRoom(code);
    if (!ack.ok) {
      toast(ack.error ?? '加入房间失败');
      return;
    }
    history.replaceState(null, '', `?room=${code}`);
    channel.hello(nickname);
    setText('conn', '已连接');
  };

  // 等服务端 ready 后再进房（要用它给的随机房码）
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (channel.serverInfo || channel.socket?.connected) {
        clearInterval(t);
        resolve();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(t);
      resolve();
    }, 4000);
  });
  await boot();

  // 重连后自动重新进房（服务端会凭 token 恢复座位）
  channel.onReconnect(() => {
    void (async () => {
      if (!channel.code) return;
      await channel.joinRoom(channel.code);
      channel.hello(nickname);
    })();
  });

  render();
}

main().catch((err) => {
  console.error(err);
  const node = el('banner');
  if (node) {
    node.textContent = `启动失败：${err.message}`;
    node.className = 'banner kind-lose';
  }
});

