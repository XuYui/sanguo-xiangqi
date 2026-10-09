/**
 * 生成走法可视化图（SVG），用于人工核对棋规。
 *
 * 运行： npm run diagrams --workspace @sanguo/core
 * 输出： packages/core/diagrams/*.svg
 *
 * 这些图不是给终端用户看的界面，而是「规则审阅图」：
 * 把引擎算出来的走法直接画在真实棋盘底图上，肉眼即可判断对错。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOARD_RADIUS,
  PLAYERS,
  POINTS,
  POINT_BY_ID,
  getAdjacency,
  getEdges,
  forwardNeighbours,
  isForwardStep,
  neighboursOf,
  playerPoints,
  palacePoints,
  squareId,
} from '../src/board.ts';
import { advisorTargets, elephantTargets, generalTargets, movesFor } from '../src/moves.ts';
import { DEFAULT_RULES, PLAYER_KEYS, type PlayerKey, type PieceKind } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'diagrams');
const BOARD_SVG = readFileSync(join(HERE, '..', 'data', 'board-empty.svg'), 'utf-8');

// ---------------------------------------------------------------------------
// 坐标换算（与生成器一致：size=1200, margin=0.17）
// ---------------------------------------------------------------------------
const SIZE = 1200;
const MARGIN = 0.17;
const SCALE = SIZE / (2 * BOARD_RADIUS + 2 * MARGIN);
const CELL = 0.125 * SCALE; // 底线格距对应的像素，约 64

function toSvg(id: string): { x: number; y: number } {
  const p = POINT_BY_ID.get(id);
  if (!p) throw new Error(`不存在的点: ${id}`);
  return { x: SIZE / 2 + p.x * SCALE, y: SIZE / 2 + p.y * SCALE };
}

/** 把模型坐标点直接换算（用于画河道等） */
function modelToSvg(x: number, y: number): { x: number; y: number } {
  return { x: SIZE / 2 + x * SCALE, y: SIZE / 2 + y * SCALE };
}

// ---------------------------------------------------------------------------
// SVG 片段工具
// ---------------------------------------------------------------------------

function boardBase(): string {
  // 去掉 XML 声明和 title/desc，只留内容，便于嵌入
  const inner = BOARD_SVG.replace(/^<\?xml[^>]*\?>\s*/, '');
  return inner;
}

function dot(id: string, colour: string, r: number, opacity = 1): string {
  const { x, y } = toSvg(id);
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${colour}" opacity="${opacity}"/>`;
}

function ring(id: string, colour: string, r: number, width = 3, opacity = 1): string {
  const { x, y } = toSvg(id);
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="none" stroke="${colour}" stroke-width="${width}" opacity="${opacity}"/>`;
}

function edgeLine(a: string, b: string, colour: string, width: number, dash?: string): string {
  const p = toSvg(a);
  const q = toSvg(b);
  const d = dash ? ` stroke-dasharray="${dash}"` : '';
  return `<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke="${colour}" stroke-width="${width}" stroke-linecap="round"${d}/>`;
}

function label(text: string, x: number, y: number, size = 22, colour = '#141414', anchor = 'middle', weight = '600'): string {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" font-weight="${weight}" fill="${colour}" text-anchor="${anchor}" dominant-baseline="central" paint-order="stroke" stroke="#fdf6e3" stroke-width="4">${text}</text>`;
}

function pieceGlyph(kind: PieceKind): string {
  const map: Record<PieceKind, string> = {
    rook: '車',
    horse: '馬',
    elephant: '相',
    advisor: '仕',
    general: '帥',
    cannon: '炮',
    soldier: '兵',
  };
  return map[kind];
}

function pieceAt(id: string, kind: PieceKind, colour: string, selected = false): string {
  const { x, y } = toSvg(id);
  const r = 0.062 * SCALE; // 与生成器 PIECE_R=0.052 略大，便于看图
  const stroke = selected ? '#f59e0b' : colour;
  return [
    `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#fdf6e3" stroke="${stroke}" stroke-width="${selected ? 6 : 4}"/>`,
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${(r * 1.25).toFixed(1)}" font-weight="700" fill="${colour}" text-anchor="middle" dominant-baseline="central">${pieceGlyph(kind)}</text>`,
  ].join('');
}

function legend(items: readonly (readonly [string, string])[], x: number, y: number): string {
  return items
    .map(([swatch, text], i) => {
      const yy = y + i * 34;
      return `<g><rect x="${x}" y="${yy - 11}" width="26" height="22" rx="5" fill="${swatch}" opacity="0.85"/>${label(text, x + 36, yy, 21, '#141414', 'start', '500')}</g>`;
    })
    .join('');
}

function frame(title: string, subtitle: string, body: string, extraNote?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" font-family="'Noto Serif CJK SC','Source Han Serif SC','Songti SC','STSong','SimSun','Microsoft YaHei','serif'">
<title>${title}</title>
<rect width="${SIZE}" height="${SIZE}" fill="#fdf6e3"/>
${boardBase()}
<g id="overlay">
${body}
</g>
<g id="annotation">
  <rect x="0" y="0" width="${SIZE}" height="76" fill="#141414" opacity="0.82"/>
  ${label(title, 24, 26, 30, '#fdf6e3', 'start', '700')}
  ${label(subtitle, 24, 56, 20, '#e8dcc0', 'start', '400')}
  ${extraNote ? label(extraNote, SIZE - 24, 40, 19, '#e8dcc0', 'end', '400') : ''}
</g>
</svg>`;
}

// ---------------------------------------------------------------------------
// 图 1：棋盘可通行图总览
// ---------------------------------------------------------------------------

function diagramGraph(): string {
  const parts: string[] = [];

  // 本家格线（细灰）
  for (const e of getEdges(DEFAULT_RULES)) {
    if (e.kind === 'grid') parts.push(edgeLine(e.a, e.b, '#8a7f6a', 1.2));
  }
  // 跨河渡口（醒目）
  for (const e of getEdges(DEFAULT_RULES)) {
    if (e.kind !== 'crossing') continue;
    parts.push(edgeLine(e.a, e.b, '#c1121f', 9));
    parts.push(edgeLine(e.a, e.b, '#ffd166', 4));
  }
  // 渡口点
  for (const e of getEdges(DEFAULT_RULES)) {
    if (e.kind !== 'crossing') continue;
    parts.push(ring(e.a, '#c1121f', 20, 5));
    parts.push(ring(e.b, '#c1121f', 20, 5));
  }
  // 九宫
  for (const k of PLAYER_KEYS) {
    for (const p of palacePoints(k)) {
      if (p.rank === 1 || p.rank === 3 || p.file === 4 || p.file === 6) {
        parts.push(dot(p.id, PLAYERS[k].colour, 5, 0.5));
      }
    }
  }
  // 中央三角形
  const verts = PLAYER_KEYS.map((k) => modelToSvg(POINT_BY_ID.get(`${k}:5,5`)!.x, POINT_BY_ID.get(`${k}:5,5`)!.y));
  parts.push(
    `<polygon points="${verts.map((v) => `${v.x.toFixed(1)},${v.y.toFixed(1)}`).join(' ')}" fill="none" stroke="#7a5c2e" stroke-width="3" stroke-dasharray="10 8"/>`,
  );

  const stats = [
    `共 ${POINTS.length} 个交叉点`,
    `共 ${getEdges(DEFAULT_RULES).length} 条可通行边（其中跨河 ${getEdges(DEFAULT_RULES).filter((e) => e.kind === 'crossing').length} 条）`,
    '度数：4 度 63 点 / 3 度 66 点 / 2 度 6 点',
  ];
  const body =
    parts.join('\n') +
    '\n' +
    legend(
      [
        ['#8a7f6a', '本家格线（同一家地盘内的行线 / 列线）'],
        ['#c1121f', '界河跨河边（跨家通道；三条界河共 15 条，最外端为角点渡口）'],
        ['#7a5c2e', '中央三角形（印刷装饰腔，棋子进不去）'],
      ],
      40,
      SIZE - 130,
    ) +
    '\n' +
    stats
      .map((s, i) => label(s, SIZE - 40, SIZE - 130 + i * 34, 21, '#141414', 'end', '500'))
      .join('\n');

  return frame(
    '① 棋盘可通行图',
    '三家地盘各 45 点；三条界河共 15 条跨河边，角点渡口与最内一行构成闭合内环',
    body,
    `模型半径 R = ${BOARD_RADIUS}`,
  );
}

// ---------------------------------------------------------------------------
// 图 2~5：单车 / 单马 / 单炮 / 单兵 的走法
// ---------------------------------------------------------------------------

function movingPieceDiagram(opts: {
  title: string;
  subtitle: string;
  origin: string;
  glyph: PieceKind;
  targets: readonly string[];
  blocked?: readonly string[];
  blockers?: readonly string[];
  note?: string;
}): string {
  const { title, subtitle, origin, glyph, targets, blocked = [], blockers = [] } = opts;
  const colour = PLAYERS[POINT_BY_ID.get(origin)!.player].colour;

  const parts: string[] = [];
  // 连线
  for (const t of targets) {
    parts.push(edgeLine(origin, t, colour, 7, '16 10'));
    parts.push(dot(t, colour, 20, 0.28));
    parts.push(ring(t, colour, 20, 4));
  }
  for (const t of blocked) {
    parts.push(dot(t, '#b0a894', 16, 0.35));
    parts.push(ring(t, '#b0a894', 16, 3));
  }
  for (const b of blockers) parts.push(pieceAt(b, 'soldier', '#8d6e63'));
  parts.push(pieceAt(origin, glyph, colour, true));

  const body =
    parts.join('\n') +
    '\n' +
    legend(
      [
        [colour, `起点（橙色描边）与可达点（虚线圈）`],
        ['#b0a894', '被挡住 / 不可达'],
      ],
      40,
      SIZE - 100,
    );

  return frame(title, subtitle, body, opts.note);
}

/** 空棋盘上某枚棋子的全部落点（由引擎计算，图与规则永不脱节） */
function engineTargets(kind: PieceKind, owner: PlayerKey, from: string, occupied: readonly string[] = []): string[] {
  const occ = new Set(occupied);
  const m = movesFor({ kind, owner }, from, (sq) => occ.has(sq));
  return [...m.quiet, ...m.captures];
}

export function makeRookDiagram(): string {
  const origin = 'wei:2,3';
  return movingPieceDiagram({
    title: '② 車：行线贯穿全行，列线跨河接到对岸第 10 − f 列',
    subtitle: '魏車 (2,3)：横走整条第 3 行；纵走过赤壁接吴第 8 列直到吴底线',
    origin,
    glyph: 'rook',
    targets: engineTargets('rook', 'wei', origin),
  });
}

export function makeRookCrossDiagram(): string {
  const origin = 'wei:5,3';
  return movingPieceDiagram({
    title: '③ 車 走中路：第 5 列在中央三角顶点分成两路',
    subtitle: '魏(5,5) 同时面对赤壁与祁山，沿第 5 列直上可进入蜀、吴的第 5 列',
    origin,
    glyph: 'rook',
    targets: engineTargets('rook', 'wei', origin),
  });
}

export function makeHorseDiagram(): string {
  const origin = 'wei:2,4';
  const blocker = 'wei:3,4';
  const free = engineTargets('horse', 'wei', origin);
  const withBlocker = new Set(engineTargets('horse', 'wei', origin, [blocker]));
  return movingPieceDiagram({
    title: '④ 馬 走日：马腿在长边的第一格，可跨河',
    subtitle: '魏馬 (2,4)：经马腿 (2,5) 跳过赤壁；(3,4) 有子时向右两路被蹩住',
    origin,
    glyph: 'horse',
    targets: free.filter((t) => withBlocker.has(t)),
    blocked: free.filter((t) => !withBlocker.has(t)),
    blockers: [blocker],
  });
}

export function makeElephantDiagram(): string {
  const origin = 'wei:3,3';
  const parts: string[] = [];
  const colour = PLAYERS.wei.colour;
  for (const [eye, landing] of elephantTargets('wei', origin)) {
    parts.push(edgeLine(origin, landing, colour, 7, '16 10'));
    parts.push(dot(landing, colour, 20, 0.28));
    parts.push(ring(landing, colour, 20, 4));
    parts.push(dot(eye, '#8d6e63', 10, 0.9));
  }
  parts.push(pieceAt(origin, 'elephant', colour, true));
  const body =
    parts.join('\n') +
    '\n' +
    legend(
      [
        [colour, '可达点（斜走两格）'],
        ['#8d6e63', '象眼（对角中点，有子即塞象眼）'],
      ],
      40,
      SIZE - 100,
    );
  return frame(
    '⑤ 相 走田：象眼是对角中点，不过河',
    '魏相在 (3,3)：四个斜向各走两格；全程只能到达自家 7 个相位（与象棋相同）',
    body,
  );
}

// ---------------------------------------------------------------------------
// 图 6：兵的完整路线（过河前只进，过河后可横，永不后退）
// ---------------------------------------------------------------------------

function pawnRouteDiagram(): string {
  const origin = 'wei:3,4';
  const route = [
    'wei:3,4',
    'wei:3,5', // 自家最内一行：仍未过河，只能向前
    'wu:7,5', // 过赤壁（我方 3 路 = 对方 7 路）
    'wu:7,4', // 过河后向吴家底线推进
    'wu:7,3',
    'wu:6,3', // 过河兵横走
    'wu:6,2',
    'wu:5,2', // 抵达吴家九宫中心
  ];
  for (let i = 0; i + 1 < route.length; i++) {
    if (!isForwardStep('wei', route[i]!, route[i + 1]!)) {
      throw new Error(`兵路线第 ${i + 1} 步 ${route[i]} → ${route[i + 1]} 不合规则`);
    }
  }
  const parts: string[] = [];
  const colour = PLAYERS.wei.colour;
  for (let i = 0; i + 1 < route.length; i++) {
    parts.push(edgeLine(route[i]!, route[i + 1]!, colour, 6, '14 8'));
  }
  route.forEach((id, i) => {
    parts.push(dot(id, colour, i === 0 ? 20 : 12, i === 0 ? 1 : 0.75));
    parts.push(label(String(i), toSvg(id).x + 22, toSvg(id).y - 20, 19, '#141414'));
  });
  // 过河后的一个位置上，兵的全部可走点
  const sample = 'wu:7,3';
  for (const t of forwardNeighbours('wei', sample)) parts.push(ring(t, '#c1121f', 18, 3));
  parts.push(pieceAt(origin, 'soldier', colour, true));
  parts.push(pieceAt('wu:5,1', 'general', PLAYERS.wu.colour));

  const body =
    parts.join('\n') +
    '\n' +
    legend(
      [
        [colour, '魏兵的一条进攻路线（编号 = 步数）'],
        ['#c1121f', `兵在 ${sample} 时可走的点：前进或横走`],
      ],
      40,
      SIZE - 100,
    );

  return frame(
    '⑥ 兵的走法与一条完整进攻路线',
    '未过河只能向前；过河后可前进、可横走；永不后退，也不能再过第二条河',
    body,
  );
}

// ---------------------------------------------------------------------------
// 图 7：仕 / 帥 的九宫
// ---------------------------------------------------------------------------

function palaceDiagram(): string {
  const parts: string[] = [];
  const colour = PLAYERS.wei.colour;
  const general = 'wei:5,1';
  const advisor = 'wei:5,2';
  for (const t of generalTargets(general)) parts.push(ring(t, colour, 18, 4));
  for (const t of advisorTargets(advisor)) {
    parts.push(edgeLine(advisor, t, '#1d3557', 6, '12 8'));
    parts.push(ring(t, '#1d3557', 22, 4));
  }
  parts.push(pieceAt(general, 'general', colour, true));
  parts.push(pieceAt(advisor, 'advisor', colour, true));
  const body =
    parts.join('\n') +
    '\n' +
    legend(
      [
        [colour, '帥：九宫内直走一格'],
        ['#1d3557', '仕：沿九宫两条斜线走一格（只有中心 ⟷ 四角）'],
      ],
      40,
      SIZE - 100,
    );
  return frame('⑦ 帥 与 仕：不出九宫', '九宫 = 第 4~6 列 × 第 1~3 行；帥照面判定沿跨河列线进行', body);
}

// ---------------------------------------------------------------------------

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const files: Record<string, string> = {
    '01-可通行图.svg': diagramGraph(),
    '02-車走法.svg': makeRookDiagram(),
    '03-車中路.svg': makeRookCrossDiagram(),
    '04-馬走法.svg': makeHorseDiagram(),
    '05-相走法.svg': makeElephantDiagram(),
    '06-兵走法.svg': pawnRouteDiagram(),
    '07-仕帥九宫.svg': palaceDiagram(),
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(OUT_DIR, name);
    writeFileSync(path, content, 'utf-8');
    console.log(`已生成 ${path}  (${(content.length / 1024).toFixed(1)} KB)`);
  }

  // 终端也打一份关键数据，便于快速核对
  console.log('\n=== 渡口 ===');
  for (const e of getEdges(DEFAULT_RULES)) {
    if (e.kind !== 'crossing') continue;
    console.log(`  ${e.a}  ↔  ${e.b}`);
  }
  console.log('\n=== 各棋子从蜀(5,1) 的走法数（规则自检）===');
  console.log('  兵 从 shu:5,4 出发:', forwardNeighbours('shu', 'shu:5,4').length, '种');
  console.log('  兵 从 shu:5,5 出发:', forwardNeighbours('shu', 'shu:5,5').length, '种');
  console.log('  兵 从 shu:9,5 出发:', forwardNeighbours('shu', 'shu:9,5').length, '种');
  console.log('\n=== 邻接抽查 ===');
  for (const id of ['wei:1,5', 'wei:5,5', 'shu:5,1', 'wu:9,5']) {
    console.log(`  ${id}: ${neighboursOf(id).join(', ')}`);
  }
  void squareId;
  void playerPoints;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
