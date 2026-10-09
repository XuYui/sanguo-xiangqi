/**
 * 棋盘渲染（纯 DOM/SVG，无框架依赖）
 *
 * DOM 结构：
 *   <svg viewBox="0 0 1200 1200">
 *     <g id="spin" transform="rotate(0 600 600)">   ← 固定魏视角的棋盘层
 *       ...底图（board.svg 的内容）...
 *       <g id="highlights">  选中/可走点/上一步
 *       <g id="pieces">      棋子
 *     </g>
 *   </svg>
 *
 * 关键点：**底图、高亮、棋子必须在同一个旋转层里**，
 * 这样它们共享同一套 SVG 像素坐标（board-geometry.json 给出的 x/y），
 * 不需要任何逐元素的角度换算。
 *
 * 页面固定使用魏视角：模型坐标中的魏家底线保持在屏幕下方，旋转角为 0°。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 棋子字形。传统象棋里红黑双方字形不同，这里三家也做区分以增加辨识度。 */
const GLYPHS = {
  wei: { rook: '車', horse: '馬', elephant: '相', advisor: '仕', general: '帥', cannon: '炮', soldier: '兵' },
  shu: { rook: '車', horse: '馬', elephant: '相', advisor: '仕', general: '帥', cannon: '炮', soldier: '兵' },
  wu: { rook: '車', horse: '馬', elephant: '象', advisor: '士', general: '將', cannon: '炮', soldier: '卒' },
};

const KIND_NAME = {
  rook: '車', horse: '馬', elephant: '相', advisor: '仕', general: '帥', cannon: '炮', soldier: '兵',
};

export function glyphOf(piece) {
  return (GLYPHS[piece.owner] ?? GLYPHS.wei)[piece.kind] ?? '?';
}

export function kindName(kind) {
  return KIND_NAME[kind] ?? kind;
}

let geometryCache = null;

/** 载入棋盘几何（board-geometry.json），带缓存 */
export async function loadGeometry(url = 'board-geometry.json') {
  if (geometryCache) return geometryCache;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`载入棋盘几何失败: ${url} HTTP ${res.status}`);
  const text = await res.text();
  // 静态服务在路径不存在时会回退到 index.html，这里明确报错而不是抛 JSON 解析异常
  if (!text.trimStart().startsWith('{')) {
    throw new Error(`棋盘几何文件不是 JSON（可能被 SPA 回退成 HTML）: ${url}`);
  }
  geometryCache = JSON.parse(text);
  return geometryCache;
}

/** 载入纯棋盘底图文本 */
export async function loadBaseSvg(url = 'board-plain.svg') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`载入棋盘底图失败: ${url} HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('<svg')) throw new Error(`棋盘底图不是 SVG: ${url}`);
  return text;
}

/**
 * 从完整 SVG 文本中提取「内部内容」。
 *
 * 关键：不能直接把整段 SVG 塞进 <g>——那会创建一个**嵌套视口**
 * （内层 <svg> 自带 viewBox 与 width/height=100%），它的坐标系与外层不一致，
 * 会让点击命中与坐标换算全部错位（曾导致点击落在底图自带的透明热区上）。
 * 这里剥掉外层 <svg> 标签，只保留内部元素，让所有图层共享同一个坐标系。
 */
export function extractSvgInner(svgText) {
  const open = svgText.indexOf('<svg');
  if (open < 0) throw new Error('不是有效的 SVG');
  const openEnd = svgText.indexOf('>', open);
  const close = svgText.lastIndexOf('</svg>');
  if (openEnd < 0 || close < 0) throw new Error('SVG 结构不完整');
  return svgText.slice(openEnd + 1, close);
}

/**
 * 构造棋盘 SVG。
 * @param {object} geom loadGeometry() 的结果
 * @param {{baseSvgText: string}} opts
 * @returns {{svg: SVGSVGElement, spin: SVGGElement, piecesLayer: SVGGElement, highlightsLayer: SVGGElement, pointOf: (id:string)=>object}}
 */
export function buildBoard(geom, opts) {
  const rotation = 0;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${geom.size} ${geom.size}`);
  svg.setAttribute('class', 'board-svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const defs = document.createElementNS(SVG_NS, 'defs');
  const piecePattern = document.createElementNS(SVG_NS, 'pattern');
  piecePattern.setAttribute('id', 'piece-lacquer-texture');
  piecePattern.setAttribute('patternUnits', 'userSpaceOnUse');
  piecePattern.setAttribute('width', `${geom.size}`);
  piecePattern.setAttribute('height', `${geom.size}`);
  const pieceTexture = document.createElementNS(SVG_NS, 'image');
  pieceTexture.setAttribute('href', '/assets/piece-lacquer-texture.jpg');
  pieceTexture.setAttribute('x', '0');
  pieceTexture.setAttribute('y', '0');
  pieceTexture.setAttribute('width', `${geom.size}`);
  pieceTexture.setAttribute('height', `${geom.size}`);
  pieceTexture.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  piecePattern.appendChild(pieceTexture);
  defs.appendChild(piecePattern);
  svg.appendChild(defs);

  const spin = document.createElementNS(SVG_NS, 'g');
  spin.setAttribute('id', 'spin');
  spin.setAttribute('transform', `rotate(${rotation} ${geom.size / 2} ${geom.size / 2})`);
  svg.appendChild(spin);

  // 底图：只取内部内容，避免嵌套视口
  const holder = document.createElementNS(SVG_NS, 'g');
  holder.setAttribute('id', 'board-base');
  holder.innerHTML = extractSvgInner(opts.baseSvgText);
  spin.appendChild(holder);

  const highlights = document.createElementNS(SVG_NS, 'g');
  highlights.setAttribute('id', 'highlights');
  spin.appendChild(highlights);

  const pieces = document.createElementNS(SVG_NS, 'g');
  pieces.setAttribute('id', 'pieces');
  spin.appendChild(pieces);

  const byId = new Map(geom.points.map((p) => [p.id, p]));
  return {
    svg,
    spin,
    piecesLayer: pieces,
    highlightsLayer: highlights,
    pointOf: (id) => byId.get(id),
  };
}

/** 棋子半径（SVG 像素）。底线格距 = 64px，所以半径取 26 留出间隙。 */
export const PIECE_R = 26;

/**
 * 画一枚棋子。
 *
 * 棋子整体跟着固定的魏视角棋盘层，字形保持正立。
 *
 * @param {object} point {x,y}
 * @param {{owner:string,kind:string}} piece
 * @param {{colour:string, selected?:boolean, textRotation?:number}} opts
 */
export function renderPiece(point, piece, opts) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', `piece piece-${piece.owner}${opts.selected ? ' is-selected' : ''}`);
  g.setAttribute('data-owner', piece.owner);
  g.setAttribute('data-kind', piece.kind);
  if (opts.id) g.setAttribute('data-id', opts.id);

  const disc = document.createElementNS(SVG_NS, 'circle');
  disc.setAttribute('cx', point.x);
  disc.setAttribute('cy', point.y);
  disc.setAttribute('r', PIECE_R);
  disc.setAttribute('fill', '#f3e2bc');
  disc.setAttribute('stroke', opts.colour);
  disc.setAttribute('stroke-width', opts.selected ? 6 : 4);

  // 字形与内圈放在一个反向旋转组里，保持正立
  const rot = opts.textRotation ?? 0;
  const upright =
    rot === 0
      ? g
      : (() => {
          const r = document.createElementNS(SVG_NS, 'g');
          r.setAttribute('transform', `rotate(${-rot} ${point.x} ${point.y})`);
          g.appendChild(r);
          return r;
        })();
  g.insertBefore(disc, g.firstChild);

  const texture = document.createElementNS(SVG_NS, 'circle');
  texture.setAttribute('cx', point.x);
  texture.setAttribute('cy', point.y);
  texture.setAttribute('r', PIECE_R - 1);
  texture.setAttribute('fill', 'url(#piece-lacquer-texture)');
  texture.setAttribute('opacity', '1');
  texture.setAttribute('pointer-events', 'none');
  upright.appendChild(texture);

  const inner = document.createElementNS(SVG_NS, 'circle');
  inner.setAttribute('cx', point.x);
  inner.setAttribute('cy', point.y);
  inner.setAttribute('r', PIECE_R - 4.5);
  inner.setAttribute('fill', 'none');
  inner.setAttribute('stroke', opts.colour);
  inner.setAttribute('stroke-width', 1.2);
  inner.setAttribute('opacity', 0.7);
  upright.appendChild(inner);

  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', point.x);
  text.setAttribute('y', point.y);
  text.setAttribute('font-size', PIECE_R * 1.22);
  text.setAttribute('font-weight', '700');
  text.setAttribute('fill', opts.colour);
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.textContent = glyphOf(piece);
  upright.appendChild(text);

  return g;
}

/** 清空一层 */
export function clearLayer(layer) {
  while (layer.firstChild) layer.removeChild(layer.firstChild);
}

/**
 * 画高亮。
 * @param {SVGGElement} layer
 * @param {object} geom
 * @param {{
 *   selected?: string|null,
 *   targets?: readonly {to:{player:string,file:number,rank:number}, capture?:boolean}[],
 *   lastMove?: {from:string, to:string} | null,
 *   checkIds?: readonly string[],
 * }} state
 */
export function renderHighlights(layer, geom, state) {
  clearLayer(layer);
  const pointOf = (id) => geom.points.find((p) => p.id === id);
  const side = Math.max(8, PIECE_R * 0.72);

  // 上一步：起点与终点各画一个方框
  if (state.lastMove) {
    for (const [id, cls] of [
      [state.lastMove.from, 'from'],
      [state.lastMove.to, 'to'],
    ]) {
      const p = pointOf(id);
      if (!p) continue;
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', p.x - side);
      rect.setAttribute('y', p.y - side);
      rect.setAttribute('width', side * 2);
      rect.setAttribute('height', side * 2);
      rect.setAttribute('rx', 4);
      rect.setAttribute('fill', 'none');
      rect.setAttribute('stroke', '#f59e0b');
      rect.setAttribute('stroke-width', cls === 'to' ? 4 : 2.5);
      rect.setAttribute('opacity', cls === 'to' ? 1 : 0.6);
      layer.appendChild(rect);
    }
  }

  // 选中圈
  if (state.selected) {
    const p = pointOf(state.selected);
    if (p) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', p.x);
      c.setAttribute('cy', p.y);
      c.setAttribute('r', PIECE_R + 5);
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke', '#f59e0b');
      c.setAttribute('stroke-width', 4);
      layer.appendChild(c);
    }
  }

  // 可走点：空格画小圆点，可吃画圆环
  for (const t of state.targets ?? []) {
    const p = pointOf(`${t.to.player}:${t.to.file},${t.to.rank}`);
    if (!p) continue;
    const el = document.createElementNS(SVG_NS, 'circle');
    el.setAttribute('cx', p.x);
    el.setAttribute('cy', p.y);
    if (t.capture) {
      el.setAttribute('r', PIECE_R + 3);
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', '#c1121f');
      el.setAttribute('stroke-width', 4);
    } else {
      el.setAttribute('r', 9);
      el.setAttribute('fill', '#2a9d8f');
      el.setAttribute('opacity', 0.85);
    }
    layer.appendChild(el);
  }

  // 被将军的帥：红色警示环
  for (const id of state.checkIds ?? []) {
    const p = pointOf(id);
    if (!p) continue;
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', p.x);
    c.setAttribute('cy', p.y);
    c.setAttribute('r', PIECE_R + 8);
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', '#c1121f');
    c.setAttribute('stroke-width', 5);
    c.setAttribute('stroke-dasharray', '9 7');
    layer.appendChild(c);
  }
}

/**
 * 把客户端坐标换算成固定魏视角棋盘上的点。
 *
 * 用 SVG 自身的 API 做逆变换，比自己算角度可靠：
 * getScreenCTM() 已经包含了棋盘层与 viewBox 缩放。
 */
export function hitTest(svg, geom, clientX, clientY, maxDistance = 34) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const local = pt.matrixTransform(ctm.inverse());

  let best = null;
  let bestDist = maxDistance;
  for (const p of geom.points) {
    const d = Math.hypot(p.x - local.x, p.y - local.y);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}
