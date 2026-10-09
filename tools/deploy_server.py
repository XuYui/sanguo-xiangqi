# -*- coding: utf-8 -*-
"""部署三人象棋到一台 Linux 服务器（systemd + nginx + Let's Encrypt），只用 SSH 密钥认证。

前置：
  1) 一台可用 apt 或 dnf/yum 的 Linux 服务器，域名已解析到它；
  2) 本机有部署私钥（默认 ~/.ssh/sanguo-deploy），公钥已加入服务器 root 的 authorized_keys；
  3) 已构建产物：npm run build
  4) 本机 Python 装有 paramiko：pip install paramiko

用法：
  python tools/deploy_server.py probe     侦察服务器环境（系统 / node / nginx / certbot / 端口）
  python tools/deploy_server.py deploy    上传 .build、装依赖、配 systemd + nginx、申请证书
  python tools/deploy_server.py status    查看服务状态与本机自检
  python tools/deploy_server.py run <命令> 在服务器上执行一条命令

环境变量：
  SANGUO_HOST        服务器地址（必填）
  SANGUO_DOMAIN      站点域名（必填）
  SANGUO_SSH_PORT    SSH 端口（默认 22）
  SANGUO_SSH_KEY     私钥路径（默认 ~/.ssh/sanguo-deploy）
  SANGUO_CERT_EMAIL  Let's Encrypt 通知邮箱（可选）
"""

import os
import sys
import tarfile
import time

import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST = os.environ.get("SANGUO_HOST", "")
SSH_PORT = int(os.environ.get("SANGUO_SSH_PORT", "22"))
USER = "root"
DOMAIN = os.environ.get("SANGUO_DOMAIN", "")
KEY_FILE = os.path.expanduser(os.environ.get("SANGUO_SSH_KEY", "~/.ssh/sanguo-deploy"))
CERT_EMAIL = os.environ.get("SANGUO_CERT_EMAIL", "")

APP_DIR = "/opt/sanguo-xiangqi"
SERVICE = "sanguo-xiangqi"
APP_PORT = 3016
ACME_ROOT = "/var/www/sanguo-acme"
NODE_MIN_MAJOR = 22  # node:sqlite 需要 >= 22.5

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_DIR = os.path.join(ROOT, ".build")

PROBE = rf"""
echo "=== 系统 ==="; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; uname -m
echo "=== 资源 ==="; nproc; free -m | head -2; df -h / | tail -1
echo "=== node ==="; command -v node && node -v || echo "无 node"
echo "=== npm ==="; command -v npm && npm -v || echo "无 npm"
echo "=== nginx ==="; command -v nginx && nginx -v 2>&1 || echo "无 nginx"
echo "=== certbot ==="; command -v certbot && certbot --version 2>&1 || echo "无 certbot"
echo "=== 端口 ==="; ss -tlpnH | awk '{{print $4, $6}}' | sort -u
echo "=== 已有站点 ==="; ls /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null
echo "=== 目标目录 ==="; ls -la {APP_DIR} 2>/dev/null || echo "{APP_DIR} 不存在"
echo "DONE"
"""

# 先只有 80 端口（申请证书用）；证书到手后换成完整配置
NGINX_HTTP_ONLY = f"""# 三人中国象棋 —— 临时配置（仅用于申请证书），由 tools/deploy_server.py 生成
server {{
    listen 80;
    listen [::]:80;
    server_name {DOMAIN};

    location ^~ /.well-known/acme-challenge/ {{
        root {ACME_ROOT};
        default_type "text/plain";
        try_files $uri =404;
    }}

    location / {{
        proxy_pass http://127.0.0.1:{APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }}
}}
"""

NGINX_FULL = f"""# 三人中国象棋（三国象棋）联机对战 —— 由 tools/deploy_server.py 生成；证书由 certbot 续期
map $http_upgrade $sanguo_connection_upgrade {{
    default upgrade;
    '' close;
}}

server {{
    listen 80;
    listen [::]:80;
    server_name {DOMAIN};

    # 证书续期（webroot 方式）依赖这个目录
    location ^~ /.well-known/acme-challenge/ {{
        root {ACME_ROOT};
        default_type "text/plain";
        try_files $uri =404;
    }}

    location / {{
        return 301 https://{DOMAIN}$request_uri;
    }}
}}

server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/{DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:sanguo:2m;
    ssl_session_timeout 1h;

    client_max_body_size 1m;

    # 静态资源带版本号（?v=），可以缓存；HTML 由服务端返回 no-cache
    location ~* \\.(?:css|js|svg|png|jpg|webp|ico|woff2|json)$ {{
        proxy_pass http://127.0.0.1:{APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        expires 1h;
        add_header Cache-Control "public";
    }}

    location /socket.io/ {{
        proxy_pass http://127.0.0.1:{APP_PORT}/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $sanguo_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }}

    location / {{
        proxy_pass http://127.0.0.1:{APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }}
}}
"""

SERVICE_UNIT = f"""[Unit]
Description=三人中国象棋（三国象棋）联机服务
Documentation=https://{DOMAIN}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory={APP_DIR}
Environment=NODE_ENV=production
Environment=PORT={APP_PORT}
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/env node {APP_DIR}/index.js
Restart=always
RestartSec=3
MemoryMax=350M
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
"""


def connect() -> paramiko.SSHClient:
    if not HOST or not DOMAIN:
        raise SystemExit("请先设置环境变量 SANGUO_HOST 与 SANGUO_DOMAIN（见文件开头说明）")
    if not os.path.exists(KEY_FILE):
        raise SystemExit(f"找不到部署私钥 {KEY_FILE}")
    cli = paramiko.SSHClient()
    cli.load_system_host_keys()
    known = os.path.expanduser("~/.ssh/known_hosts")
    if os.path.exists(known):
        cli.load_host_keys(known)
    cli.set_missing_host_key_policy(paramiko.RejectPolicy())
    cli.connect(HOST, port=SSH_PORT, username=USER, key_filename=KEY_FILE, timeout=25,
                allow_agent=False, look_for_keys=False)
    return cli


def run(cli, cmd, timeout=900, check=True):
    _in, out, err = cli.exec_command(f"bash -lc {sh_quote(cmd)}", timeout=timeout)
    o = out.read().decode("utf-8", "replace")
    e = err.read().decode("utf-8", "replace")
    rc = out.channel.recv_exit_status()
    if o:
        print(o.rstrip())
    if e.strip():
        print("--- stderr ---")
        print(e.rstrip())
    if check and rc != 0:
        raise SystemExit(f"远程命令失败（退出码 {rc}）")
    return rc, o, e


def sh_quote(s: str) -> str:
    return "'" + s.replace("'", "'\"'\"'") + "'"


def put_text(cli, path: str, text: str) -> None:
    sftp = cli.open_sftp()
    with sftp.open(path, "w") as f:
        f.write(text)
    sftp.close()


def make_archive() -> str:
    if not os.path.isfile(os.path.join(BUILD_DIR, "index.js")):
        raise SystemExit("没有 .build 产物：先运行 npm run build")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    tar_path = os.path.join(ROOT, ".tmp", f"sanguo-build-{stamp}.tar.gz")
    os.makedirs(os.path.dirname(tar_path), exist_ok=True)
    with tarfile.open(tar_path, "w:gz") as tf:
        for name in sorted(os.listdir(BUILD_DIR)):
            tf.add(os.path.join(BUILD_DIR, name), arcname=name)
    print(f"已打包 {tar_path}  ({os.path.getsize(tar_path) / 1024:.0f} KB)")
    return tar_path


def ensure_runtime(cli) -> None:
    print("\n=== 运行环境（node / nginx / certbot）===")
    run(cli, rf"""
set -e
need_node=1
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge {NODE_MIN_MAJOR} ] && need_node=0
fi
if [ $need_node = 1 ]; then
  echo "安装 Node.js {NODE_MIN_MAJOR}.x …"
  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg >/dev/null
    curl -fsSL https://deb.nodesource.com/setup_{NODE_MIN_MAJOR}.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  else
    curl -fsSL https://rpm.nodesource.com/setup_{NODE_MIN_MAJOR}.x | bash - >/dev/null
    (dnf install -y nodejs || yum install -y nodejs) >/dev/null
  fi
fi
echo "node $(node -v)"
if ! command -v nginx >/dev/null || ! command -v certbot >/dev/null; then
  echo "安装 nginx / certbot …"
  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq nginx certbot >/dev/null
  else
    (dnf install -y nginx certbot || yum install -y nginx certbot) >/dev/null
  fi
fi
systemctl enable --now nginx >/dev/null 2>&1 || true
nginx -v 2>&1; certbot --version 2>&1
""", timeout=1200)


def install_app(cli) -> None:
    tar_path = make_archive()
    remote_tar = f"/tmp/{os.path.basename(tar_path)}"
    sftp = cli.open_sftp()
    print(f"上传 {os.path.basename(tar_path)} …")
    sftp.put(tar_path, remote_tar)
    sftp.close()

    print("\n=== 解包（保留 data/ 与 node_modules/，上一版备份到 .prev）===")
    run(cli, f"""
set -e
mkdir -p {APP_DIR}
if [ -f {APP_DIR}/index.js ]; then
  rm -rf {APP_DIR}.prev && cp -a {APP_DIR} {APP_DIR}.prev && echo "已备份上一版到 {APP_DIR}.prev"
fi
find {APP_DIR} -mindepth 1 -maxdepth 1 ! -name data ! -name node_modules -exec rm -rf {{}} +
tar xzf {remote_tar} -C {APP_DIR}
rm -f {remote_tar}
ls {APP_DIR}
""")

    print("\n=== 运行时依赖（npm install --omit=dev）===")
    run(cli, f"""
set -e
cd {APP_DIR}
# npm 可能没有加入 PATH（node 以软链接方式安装时），从 node 所在目录取
NPM="$(command -v npm || echo "$(dirname "$(readlink -f "$(command -v node)")")/npm")"
"$NPM" install --omit=dev --no-audit --no-fund 2>&1 | tail -3 \
  || "$NPM" install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com 2>&1 | tail -3
node -e "import('socket.io').then(()=>console.log('socket.io 可用 ✔'))"
""", timeout=900)

    print("\n=== systemd ===")
    put_text(cli, f"/etc/systemd/system/{SERVICE}.service", SERVICE_UNIT)
    run(cli, f"systemctl daemon-reload && systemctl enable {SERVICE} >/dev/null 2>&1 && systemctl restart {SERVICE} "
             f"&& sleep 2 && systemctl is-active {SERVICE} "
             f"&& curl -s -o /dev/null -w 'healthz -> %{{http_code}}\\n' http://127.0.0.1:{APP_PORT}/healthz")


def nginx_site_path(cli) -> str:
    rc, _o, _e = run(cli, "test -d /etc/nginx/sites-available", check=False)
    return f"/etc/nginx/sites-available/{SERVICE}" if rc == 0 else f"/etc/nginx/conf.d/{SERVICE}.conf"


def enable_site(cli, path: str, text: str) -> None:
    put_text(cli, path, text)
    link = path
    if path.startswith("/etc/nginx/sites-available/"):
        link = f"/etc/nginx/sites-enabled/{SERVICE}"
        run(cli, f"ln -sf {path} {link}")
    # 同机还有其它站点：配置校验失败就撤掉本站，绝不让坏配置留在 nginx 里
    run(cli, f"if nginx -t 2>&1; then systemctl reload nginx && echo 'nginx 已重载'; "
             f"else rm -f {link}; echo '配置校验失败，已撤下本站配置'; exit 1; fi")


def setup_https(cli) -> None:
    print("\n=== nginx + HTTPS ===")
    site = nginx_site_path(cli)
    run(cli, f"mkdir -p {ACME_ROOT} && chmod 755 {ACME_ROOT}")
    rc, _o, _e = run(cli, f"test -f /etc/letsencrypt/live/{DOMAIN}/fullchain.pem", check=False)
    if rc != 0:
        enable_site(cli, site, NGINX_HTTP_ONLY)
        email = f"--email {CERT_EMAIL}" if CERT_EMAIL else "--register-unsafely-without-email"
        run(cli, f"certbot certonly --webroot -w {ACME_ROOT} -d {DOMAIN} --non-interactive --agree-tos {email}",
            timeout=600)
    enable_site(cli, site, NGINX_FULL)
    run(cli, f"certbot renew --cert-name {DOMAIN} --dry-run 2>&1 | tail -3", check=False, timeout=600)


def status(cli) -> None:
    run(cli, f"""
systemctl is-active {SERVICE}
echo -n "healthz   : "; curl -s -o /dev/null -w '%{{http_code}}\\n' http://127.0.0.1:{APP_PORT}/healthz
echo -n "http 域名 : "; curl -s -o /dev/null -w '%{{http_code}}\\n' -H 'Host: {DOMAIN}' http://127.0.0.1/
echo -n "https 域名: "; curl -s -o /dev/null -w '%{{http_code}}\\n' --resolve {DOMAIN}:443:127.0.0.1 https://{DOMAIN}/
""", check=False)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    action = sys.argv[1]
    cli = connect()
    try:
        if action == "probe":
            run(cli, PROBE, check=False)
        elif action == "deploy":
            ensure_runtime(cli)
            install_app(cli)
            setup_https(cli)
            print("\n=== 自检 ===")
            status(cli)
        elif action == "status":
            status(cli)
        elif action == "run":
            run(cli, " ".join(sys.argv[2:]), check=False)
        else:
            print(__doc__)
            return 2
    finally:
        cli.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
