/**
 * 构建可部署产物（不需要 node_modules，服务器上直接用 node 跑）
 *
 * 产物结构（.build/）：
 *   index.js            服务入口
 *   room.js / transport.js
 *   core/               棋规引擎编译产物
 *   data/board_data.json
 *   web/                前端静态文件
 *   package.json
 *
 * 用法： npm run build（= node tools/build.mjs）：编译 TypeScript 并组装 .build/
 */

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const BUILD = join(ROOT, '.build');

// ---------------------------------------------------------------------------
// 1) 编译 TypeScript
// ---------------------------------------------------------------------------
console.log('[build] 编译 TypeScript…');
rmSync(DIST, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'],
  { cwd: ROOT, stdio: 'inherit' },
);

// ---------------------------------------------------------------------------
// 2) 修正 core 导入相对层级（在 dist 里就地改，PowerShell 再整体拷贝）
// ---------------------------------------------------------------------------
// 源文件 apps/server/src/room.ts 导入 ../../../packages/core/src/index.ts，
// 编译后位于 dist/apps/server/src/*.js，相对路径保持五层 ../。
// 组装到 .build/ 后应变成一层：./core/index.js
console.log('[build] 修正 core 导入相对层级…');
const DEPTH_FIX = /from '(?:\.\.\/)+packages\/core\/src\/([^']+)\.js'/g;
let rewritten = 0;
for (const f of ['index.js', 'room.js', 'transport.js']) {
  const p = join(DIST, 'apps', 'server', 'src', f);
  const before = readFileSync(p, 'utf-8');
  const after = before.replace(DEPTH_FIX, "from './core/$1.js'");
  if (after === before) continue; // 这个文件本来就不导入 core（例如 index.js 只导入 transport）
  writeFileSync(p, after, 'utf-8');
  rewritten++;
  console.log(`[build]   ${f}`);
}
if (rewritten === 0) {
  console.error('[build] ❌ 没有任何文件被改写，core 导入路径可能已经变了，请检查');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3) 生成发布目录的 package.json 与拷贝清单
// ---------------------------------------------------------------------------
console.log('[build] 生成清单…');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;
writeFileSync(
  join(DIST, 'package.json'),
  JSON.stringify(
    {
      name: 'sanguo-xiangqi-server',
      version,
      private: true,
      type: 'module',
      description: '三人中国象棋联机服务（构建产物）',
      main: 'index.js',
      license: 'MIT',
      scripts: { start: 'node index.js' },
      // 内置 node:sqlite 需要 Node >= 22.5
      engines: { node: '>=22.5' },
      dependencies: {
        'socket.io': JSON.parse(readFileSync(join(ROOT, 'apps', 'server', 'package.json'), 'utf-8')).dependencies['socket.io'],
      },
    },
    null,
    2,
  ) + '\n',
  'utf-8',
);

const manifest = {
  root: ROOT,
  dist: DIST,
  build: BUILD,
  files: [
    ['dist/apps/server/src/index.js', 'index.js'],
    ['dist/apps/server/src/room.js', 'room.js'],
    ['dist/apps/server/src/transport.js', 'transport.js'],
    // 账号系统
    ['dist/apps/server/src/store.js', 'store.js'],
    ['dist/apps/server/src/sqlite-store.js', 'sqlite-store.js'],
    ['dist/apps/server/src/auth.js', 'auth.js'],
    ['dist/apps/server/src/auth-http.js', 'auth-http.js'],
    ['dist/package.json', 'package.json'],
  ],
  dirs: [
    ['dist/packages/core/src', 'core'],
    ['packages/core/data', 'data'],
    ['apps/web/public', 'web'],
  ],
};
writeFileSync(join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf-8');

// ---------------------------------------------------------------------------
// 4) 组装 .build/
// ---------------------------------------------------------------------------
// 注意：不用 fs.cpSync / copyFileSync —— 它们在 Windows + 中文路径下会以
// 0xC0000409（STATUS_STACK_BUFFER_OVERRUN）崩溃；逐个读写文件则稳定。
console.log(`[build] 组装到 ${BUILD}`);
rmSync(BUILD, { recursive: true, force: true });

function copyFile(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, readFileSync(src));
}
function copyDir(src, dst) {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) copyFile(from, to);
  }
}
for (const [src, dst] of manifest.files) copyFile(join(ROOT, src), join(BUILD, dst));
for (const [src, dst] of manifest.dirs) copyDir(join(ROOT, src), join(BUILD, dst));

// 自检
const required = [
  'index.js', 'room.js', 'transport.js', 'package.json',
  'core/index.js', 'core/board.js', 'data/board_data.json',
  'web/index.html', 'web/app/app.js', 'web/board-geometry.json', 'web/board-plain.svg',
];
const missing = required.filter((f) => !existsSync(join(BUILD, f)));
if (missing.length) {
  console.error(`[build] ❌ 缺少文件: ${missing.join(', ')}`);
  process.exit(1);
}
if (!readFileSync(join(BUILD, 'room.js'), 'utf-8').includes("from './core/index.js'")) {
  console.error('[build] ❌ room.js 的 core 导入路径未正确改写');
  process.exit(1);
}
console.log('[build] ✅ 完成 -> .build/（部署时在该目录执行 npm install --omit=dev 安装 socket.io）');
