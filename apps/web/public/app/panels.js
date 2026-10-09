/**
 * 界面组件（纯函数式小部件，无框架）
 *
 * 每个函数接收数据、返回 DOM 元素或就地更新已有元素。
 * 面板类 UI 不需要复杂状态，所以不引入任何框架。
 */

const STATUS_TEXT = {
  playing: '对局中',
  checkmated: '被将死',
  stalemated: '困毙',
  resigned: '认输',
  longCheck: '长将判负',
  left: '已退出',
};

const KINDS = [
  ['soldier', '兵', 5],
  ['cannon', '炮', 2],
  ['rook', '車', 2],
  ['horse', '馬', 2],
  ['elephant', '相', 2],
  ['advisor', '仕', 2],
  ['general', '帥', 1],
];

const GLYPH = {
  wei: { rook: '車', horse: '馬', elephant: '相', advisor: '仕', general: '帥', cannon: '炮', soldier: '兵' },
  shu: { rook: '車', horse: '馬', elephant: '相', advisor: '仕', general: '帥', cannon: '炮', soldier: '兵' },
  wu: { rook: '車', horse: '馬', elephant: '象', advisor: '士', general: '將', cannon: '炮', soldier: '卒' },
};

const FACTION_COLOUR = {
  wei: '#60a5fa',
  shu: '#f87171',
  wu: '#72c78c',
};

export function glyphFor(owner, kind) {
  return (GLYPH[owner] ?? GLYPH.wei)[kind] ?? '?';
}

export function statusText(s) {
  return STATUS_TEXT[s] ?? s;
}

/** 三家的名牌：昵称、势力、是否轮到自己、剩余棋子数 */
export function renderRoster(snapshot, opts) {
  const { myPlayer, mySeat, onPickSeat } = opts;
  /** 是否处于「可以选势力」的阶段：还没开局，且本行不是自己已占的座位 */
  const canPick = typeof onPickSeat === 'function' && !snapshot.game;
  const root = document.createElement('div');
  root.className = 'roster';

  const bySeat = new Map();
  for (const p of snapshot.players) {
    if (p.seat !== null) bySeat.set(p.seat, p);
  }

  for (const seat of [0, 1, 2]) {
    const player = snapshot.seatPlayers[seat];
    const member = bySeat.get(seat);
    const name = member ? member.nickname : '（空位）';
    const game = snapshot.game;
    const colour = player ? FACTION_COLOUR[player] : '#a99e8c';

    const row = document.createElement('div');
    row.className = `roster-row seat-${seat}`;
    if (game && game.turn === player && snapshot.status === 'playing') row.classList.add('is-turn');
    if (game && game.status[player] !== 'playing') row.classList.add('is-out');
    if (seat === mySeat) row.classList.add('is-me');
    // 开局前，自己的座位标注「你」，让「点空位选势力」的交互更清楚
    if (canPick && seat === mySeat) row.classList.add('is-mine');

    const chip = document.createElement('span');
    chip.className = 'roster-chip';
    chip.textContent = playerGlyph(player);
    row.appendChild(chip);

    const info = document.createElement('div');
    info.className = 'roster-info';
    const line1 = document.createElement('div');
    line1.className = 'roster-name';
    line1.textContent = `${playerName(player)} · ${name}`;
    line1.style.color = colour;
    const line2 = document.createElement('div');
    line2.className = 'roster-sub';
    if (game) {
      const count = Object.values(game.pieces).filter((pc) => pc.owner === player).length;
      line2.textContent = `${statusText(game.status[player])} · 剩 ${count} 子`;
    } else {
      line2.textContent = member ? '已就座' : '等待加入';
    }
    info.append(line1, line2);
    row.appendChild(info);

    if (!member) {
      if (canPick) {
        // 空位 = 可点击的「选这个势力」入口（省掉底部那块选势力面板）
        row.classList.add('is-pickable');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.title = `选择 ${playerName(player)}`;
        const note = document.createElement('span');
        note.className = 'roster-note pick';
        note.textContent = '选这个';
        row.appendChild(note);
        const pick = () => onPickSeat(seat);
        row.addEventListener('click', pick);
        row.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            pick();
          }
        });
      } else {
        const note = document.createElement('span');
        note.className = 'roster-note';
        note.textContent = '虚位以待';
        row.appendChild(note);
      }
    } else if (!member.online) {
      const note = document.createElement('span');
      note.className = 'roster-note offline';
      note.textContent = '掉线';
      row.appendChild(note);
    }
    root.appendChild(row);
  }
  void myPlayer;
  return root;
}

function playerGlyph(key) {
  return { wei: '魏', shu: '蜀', wu: '吴' }[key] ?? '?';
}

function playerName(key) {
  return { wei: '魏', shu: '蜀', wu: '吴' }[key] ?? '?';
}

/** 吃子盘：每家损失了哪些子 */
export function renderCaptured(snapshot) {
  const root = document.createElement('div');
  root.className = 'captured';
  const game = snapshot.game;
  if (!game) return root;

  for (const player of ['wei', 'shu', 'wu']) {
    const alive = new Set(
      Object.values(game.pieces)
        .filter((p) => p.owner === player)
        .map((p) => p.kind),
    );
    const lost = [];
    for (const [kind, , initial] of KINDS) {
      const have = Object.values(game.pieces).filter(
        (p) => p.owner === player && p.kind === kind,
      ).length;
      for (let i = have; i < initial; i++) lost.push(glyphFor(player, kind));
    }
    void alive;
    const line = document.createElement('div');
    line.className = 'captured-line';
    const label = document.createElement('span');
    label.className = 'captured-label';
    label.textContent = `${playerName(player)}失`;
    line.appendChild(label);
    if (lost.length === 0) {
      const none = document.createElement('span');
      none.className = 'captured-none';
      none.textContent = '—';
      line.appendChild(none);
    } else {
      for (const ch of lost) {
        const s = document.createElement('span');
        s.className = `captured-piece p-${player}`;
        s.textContent = ch;
        line.appendChild(s);
      }
    }
    root.appendChild(line);
  }
  return root;
}

/** 聊天记录 */
export function renderChat(messages) {
  const root = document.createElement('div');
  root.className = 'chat';
  for (const m of messages.slice(-60)) {
    const line = document.createElement('div');
    line.className = 'chat-line';
    const who = document.createElement('span');
    who.className = 'chat-who';
    who.textContent = m.from;
    if (m.seat !== null && m.seat !== undefined) who.classList.add(`s-${m.seat}`);
    const text = document.createElement('span');
    text.className = 'chat-text';
    text.textContent = m.text;
    line.append(who, text);
    root.appendChild(line);
  }
  return root;
}

/** 顶部横幅提示（轮次、将军、结束） */
export function bannerFor(snapshot, myPlayer) {
  const game = snapshot.game;
  if (!game) {
    const missing = 3 - snapshot.players.filter((p) => p.seat !== null).length;
    return missing > 0
      ? { text: `还差 ${missing} 位玩家即可开局 · 把房间码发给朋友`, kind: 'wait' }
      : { text: '准备开局…', kind: 'wait' };
  }
  if (game.phase === 'finished') {
    if (!game.winner) return { text: '三家全部出局，本局无胜者', kind: 'over' };
    return {
      text: `${playerName(game.winner)} 成为最后的存活者`,
      kind: game.winner === myPlayer ? 'win' : 'lose',
    };
  }
  // 自己被将军（服务端下发的权威结果）
  if (myPlayer && (snapshot.checkedPlayers ?? []).includes(myPlayer)) {
    return { text: '你被将军了 —— 必须走一步解将', kind: 'check' };
  }
  const others = (snapshot.checkedPlayers ?? []).filter((k) => k !== myPlayer);
  if (others.length > 0) {
    return { text: `${others.map(playerName).join('、')} 被将军`, kind: 'check' };
  }
  if (myPlayer && game.status[myPlayer] && game.status[myPlayer] !== 'playing') {
    const me = statusText(game.status[myPlayer]);
    return { text: `你已出局（${me}）—— 可以留下观战`, kind: 'lose' };
  }
  if (game.turn === myPlayer) return { text: '轮到你走子', kind: 'turn' };
  return { text: `等待 ${playerName(game.turn)} 走子`, kind: 'wait' };
}

export { playerName, playerGlyph };
