# 部署说明

本项目是**一个 Node 进程 + 一个 SQLite 文件**，不依赖 Docker、数据库服务或 Redis。
推荐的生产形态：systemd 托管 Node 进程，nginx 反向代理并终结 TLS，证书由 Let's Encrypt 签发。

## 1. 构建

```bash
npm ci
npm run check   # 类型检查 + 全部测试
npm run build   # 产物在 .build/
```

`.build/` 的结构：

```
index.js  room.js  transport.js  auth.js  auth-http.js  store.js  sqlite-store.js
core/            棋规引擎（编译后的 JS）
data/            board_data.json（棋盘几何）
web/             前端静态文件
package.json     运行时依赖只有 socket.io
```

## 2. 运行

服务器需要 **Node >= 22.5**（使用内置 `node:sqlite`）。

```bash
cd .build
npm install --omit=dev
PORT=3016 HOST=127.0.0.1 node index.js
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3011` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；放在 nginx 后面时建议 `127.0.0.1` |
| `DB_FILE` | `<程序目录>/data/sanguo.db` | SQLite 文件路径（账号、会话、落座、进行中对局） |
| `CLIENT_DIST` | 自动探测 `web/` | 前端静态目录 |
| `CORS_ORIGINS` | 空 | 允许跨域的来源，逗号分隔 |

健康检查：`GET /healthz` 返回 200。

## 3. 一键部署脚本（可选）

`tools/deploy_server.py` 会通过 SSH 完成：安装 Node / nginx / certbot（如缺失）→ 上传 `.build/` →
`npm install --omit=dev` → 写 systemd 单元 → 写 nginx 站点 → 申请 Let's Encrypt 证书 → 自检。

- **只用 SSH 密钥认证**，脚本里不保存任何密码；
- 发版时保留服务器上的 `data/`（SQLite），上一版备份到 `/opt/sanguo-xiangqi.prev`；
- nginx 配置校验失败会自动撤下本站，不影响同机其它站点。

```bash
pip install paramiko
# 首次：把公钥加入服务器 root 的 authorized_keys
ssh-keygen -t ed25519 -f ~/.ssh/sanguo-deploy

export SANGUO_HOST=<服务器地址>
export SANGUO_DOMAIN=<你的域名>
npm run build
python tools/deploy_server.py deploy
python tools/deploy_server.py status
```

## 4. nginx 要点

完整模板见 `tools/deploy_server.py` 里的 `NGINX_FULL`。关键是 Socket.IO 的路径要放行 WebSocket 升级：

```nginx
location /socket.io/ {
    proxy_pass http://127.0.0.1:3016/socket.io/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_buffering off;
}
```

> 前端目前固定使用 HTTP 长轮询（`apps/web/public/app/net.js`），以兼容会拒绝 WebSocket 升级的 CDN；
> 直连源站部署时可以改回 WebSocket。

## 5. 上线验证

```bash
node --experimental-strip-types apps/server/tools/verify-public.ts https://<你的域名>
```

它会用三个客户端在公网上建房、开局、轮流走子、认输，覆盖整条链路。
**注意**：该脚本会在目标站点注册测试账号。
