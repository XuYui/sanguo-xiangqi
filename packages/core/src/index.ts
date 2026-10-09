/**
 * @sanguo/core —— 三人象棋棋规引擎
 *
 * 纯函数、无 IO、无框架依赖，前后端共用同一份规则实现。
 *
 * 分层：
 *   board.ts   棋盘拓扑（135 点 / 243 边 / 15 条跨河边 / 九宫）
 *   lines.ts   直线运动（車/炮滑行，含渡口跨河与折点处理）
 *   moves.ts   各棋子走法生成
 *   state.ts   对局状态机（走子 / 将军 / 将死淘汰 / 长将 / 结束）
 *   types.ts   类型与规则配置
 */

export * from './types.ts';
export * from './board.ts';
export * from './lines.ts';
export * from './moves.ts';
export * from './state.ts';
