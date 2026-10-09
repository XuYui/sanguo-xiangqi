/**
 * 导出前端要用的棋盘几何数据
 *
 * 产出（写入 apps/web/public/）：
 *   board-geometry.json  每家 45 个交叉点的模型坐标 + SVG 像素坐标 + 元数据
 *   board.svg            带势力名/界河名的可读底图（大厅预览、规则说明用）
 *   board-plain.svg      对局界面底图：去掉九宫里的势力名（会与棋子打架），保留三条界河名
 *
 * 视角旋转：模型坐标 y 轴向下，正角度 = 顺时针（SVG 约定）。
 *   魏 0° / 蜀 +120° / 吴 -120°  —— 旋转后该家自己的底线落到屏幕下方。
 * 服务端与前端共用同一份角度（PLAYERS[key].rotationDeg 取反）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOARD_RADIUS,
  PLAYERS,
  POINTS,
  RIVERS,
  CENTRE_TRIANGLE,
  SEAT_ORDER,
  SVG_SCALE,
  SVG_SIZE,
  modelToSvg,
} from '../src/board.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '..', '..', 'apps', 'web', 'public');
const SRC_SVG = join(HERE, '..', 'data', 'board-empty.svg');

// ---------------------------------------------------------------------------
// 1) 几何 JSON
// ---------------------------------------------------------------------------

const geometry = {
  generatedBy: 'packages/core/tools/exportWeb.ts',
  size: SVG_SIZE,
  scale: SVG_SCALE,
  modelRadius: BOARD_RADIUS,
  /**
   * 每个视角的旋转角（SVG 度数，正 = 顺时针）。
   * 前端对棋盘层整体 rotate 这个角度，即可让该家出现在屏幕下方。
   */
  viewRotation: Object.fromEntries(
    SEAT_ORDER.map((key) => [key, -PLAYERS[key].rotationDeg]),
  ) as Record<string, number>,
  players: Object.fromEntries(
    SEAT_ORDER.map((key) => {
      const pl = PLAYERS[key];
      return [
        key,
        {
          key,
          name: pl.name,
          colour: pl.colour,
          rotationDeg: pl.rotationDeg,
          viewRotation: -pl.rotationDeg,
          rankLetters: pl.rankLetters,
        },
      ];
    }),
  ),
  rivers: RIVERS.map((r) => ({ key: r.key, name: r.name, between: r.between })),
  centreTriangle: CENTRE_TRIANGLE,
  points: POINTS.map((p) => {
    const { x, y } = modelToSvg(p.x, p.y);
    return {
      id: p.id,
      player: p.player,
      file: p.file,
      rank: p.rank,
      x,
      y,
      inPalace: p.inPalace,
      onBackRank: p.onBackRank,
      onRiverRank: p.onRiverRank,
    };
  }),
};

// ---------------------------------------------------------------------------
// 2) 纯棋盘 SVG（去掉文字标注层）
// ---------------------------------------------------------------------------

function stripAnnotations(svg: string): string {
  // 去掉 <g id="labels">…</g>（势力名写在九宫里，会被棋子压住）。
  // 界河名 <g id="rivers"> 保留：河道里没有交叉点，文字不会与棋子重叠。
  let out = svg;
  for (const id of ['labels']) {
    const open = `<g id="${id}">`;
    const start = out.indexOf(open);
    if (start < 0) continue;
    // 找到与之配对的 </g>
    let depth = 0;
    let i = start;
    for (; i < out.length; i++) {
      if (out.startsWith('<g ', i) || out.startsWith('<g>', i)) depth++;
      else if (out.startsWith('</g>', i)) {
        depth--;
        if (depth === 0) {
          i += 4;
          break;
        }
      }
    }
    out = out.slice(0, start) + out.slice(i);
  }
  return out;
}

const boardSvg = readFileSync(SRC_SVG, 'utf-8');
const plainSvg = stripAnnotations(boardSvg);

// ---------------------------------------------------------------------------
// 3) 写出
// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

writeFileSync(join(OUT_DIR, 'board-geometry.json'), JSON.stringify(geometry, null, 1), 'utf-8');
writeFileSync(join(OUT_DIR, 'board.svg'), boardSvg, 'utf-8');
writeFileSync(join(OUT_DIR, 'board-plain.svg'), plainSvg, 'utf-8');

console.log(`已输出到 ${OUT_DIR}`);
console.log(`  board-geometry.json  ${(JSON.stringify(geometry).length / 1024).toFixed(1)} KB  (${POINTS.length} 点)`);
console.log(`  board.svg            ${(boardSvg.length / 1024).toFixed(1)} KB  (带标注)`);
console.log(`  board-plain.svg      ${(plainSvg.length / 1024).toFixed(1)} KB  (无势力名，保留界河名)`);
console.log('视角旋转角：', geometry.viewRotation);
void modelToSvg;
