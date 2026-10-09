/**
 * 棋盘视图：把对局快照渲染成可交互的棋盘
 *
 * 与业务解耦——外部只需要：
 *   view.render(snapshot, { myPlayer, selected, targets })
 *   view.onSelect = (pointId) => {}
 * 点击命中判定用 SVG 自身的坐标变换（getScreenCTM 逆变换），
 * 因此固定魏视角下的缩放、响应式都不会影响落点准确性。
 */

import { buildBoard, clearLayer, hitTest, renderHighlights, renderPiece } from './render.js?v=20261009-oss1';

export class BoardView {
  /**
   * @param {HTMLElement} container
   * @param {object} geom board-geometry.json
   * @param {string} baseSvgText board-plain.svg 的内容
   */
  constructor(container, geom, baseSvgText) {
    this.container = container;
    this.geom = geom;
    this.baseSvgText = baseSvgText;
    this.view = 'wei';
    this.rotation = 0;
    this.selected = null;
    this.targets = [];
    this.lastMove = null;

    /** @type {((pointId:string)=>void) | null} */
    this.onSelect = null;

    this.board = buildBoard(geom, { view: this.view, baseSvgText });
    this.container.replaceChildren(this.board.svg);

    this.board.svg.addEventListener('click', (ev) => this.#handleClick(ev));
    this.board.svg.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      this.selected = null;
      this.targets = [];
      this.#paint();
    });
  }

  #handleClick(ev) {
    const pt = hitTest(this.board.svg, this.geom, ev.clientX, ev.clientY);
    if (!pt) return;
    this.onSelect?.(pt.id);
  }

  /** 设置当前选中与可走点（由外部业务逻辑决定） */
  setSelection(selected, targets) {
    this.selected = selected;
    this.targets = targets ?? [];
    this.#paint();
  }

  /**
   * 渲染一帧
   * @param {object|null} game GameState
   * @param {{myPlayer?:string|null, checkIds?:readonly string[], lastMove?:{from:string,to:string}|null}} opts
   */
  render(game, opts = {}) {
    const pieces = this.board.piecesLayer;
    clearLayer(pieces);

    const checkIds = opts.checkIds ?? [];
    this.lastMove = opts.lastMove ?? null;

    if (game) {
      for (const [id, piece] of Object.entries(game.pieces)) {
        const point = this.board.pointOf(id);
        if (!point) continue;
        const colour = this.geom.players[piece.owner]?.colour ?? '#333';
        pieces.appendChild(
          renderPiece(point, piece, {
            colour,
            selected: this.selected === id,
            textRotation: this.rotation,
            id,
          }),
        );
      }
    }

    renderHighlights(this.board.highlightsLayer, this.geom, {
      selected: this.selected,
      targets: this.targets,
      lastMove: this.lastMove,
      checkIds,
    });
  }

  #paint() {
    renderHighlights(this.board.highlightsLayer, this.geom, {
      selected: this.selected,
      targets: this.targets,
      lastMove: this.lastMove,
      checkIds: this.checkIds ?? [],
    });
  }

  setCheckIds(ids) {
    this.checkIds = ids;
    this.#paint();
  }
}

