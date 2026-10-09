# 参与贡献

感谢你对本项目的兴趣！提交 Issue 或 Pull Request 前，请先读完这份说明。

## 开发环境

- Node.js **22.6+**（测试直接用 `node --experimental-strip-types` 运行 TypeScript）
- 可选：Python 3.9+（棋盘几何生成器、规则图转 PNG、部署脚本）

```bash
npm ci
npm run dev     # http://localhost:3011
npm run check   # 类型检查 + 全部测试
```

## 提交前

1. **运行 `npm run check`**，类型检查与全部测试都必须通过。
   类型检查不能省：测试运行时只做类型擦除，传参顺序之类的错误只有 `tsc` 能发现。
2. **规则改动**（`packages/core/src/`）必须同时修改或新增 `packages/core/test/` 中的断言，
   并运行 `npm run board:diagrams` 更新规则图；同步更新 [docs/rules.md](docs/rules.md)。
3. **前端静态资源**（`apps/web/public/`）改动后，把 `index.html` 与 `app/*.js` 里的 `?v=` 版本号统一更新，
   保证已部署站点的浏览器缓存能刷新。
4. 棋盘几何数据（`packages/core/data/board_data.json`）由 `tools/board-generator/` 生成，请勿手改。

## 代码风格

- 跟随周围代码的写法：命名、注释密度、模块划分保持一致。
- 缩进 2 空格（Python 4 空格），LF 换行，UTF-8（见 `.editorconfig`）。
- 注释与文档以中文为主，标识符用英文。

## 提交信息

建议使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 风格，例如：

```
feat(rules): 兵过河后可以横走
fix(ui): 修正观战者看不到最后一步标记
docs: 补充部署说明
```

## 报告问题

请在 Issue 里写明：复现步骤、期望结果、实际结果；涉及走法的问题请附上棋子位置
（坐标写法 `势力:列,行`，例如 `wei:5,3`），最好附截图。
