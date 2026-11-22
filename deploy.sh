#!/usr/bin/env bash
# 一键部署：在服务器上的项目目录里执行  sudo bash deploy.sh
# 重复执行 = 更新（拉取新代码后重新构建），不会覆盖已有的 .env 和数据。
set -euo pipefail
cd "$(dirname "$0")"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { red "请用 root 或 sudo 运行"; exit 1; }

# 1. 安装 Docker
if ! command -v docker >/dev/null 2>&1; then
  green ">> 安装 Docker ..."
  curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun || curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || { red "缺少 docker compose 插件，请安装 docker-compose-plugin"; exit 1; }

# 2. 生成 .env（已存在则跳过）
if [ ! -f .env ]; then
  green ">> 首次部署，填写几个配置（之后可直接编辑 .env 修改）"
  read -rp "域名（例如 kb.example.com）: " DOMAIN
  while :; do
    read -rsp "登录密码（至少 8 位）: " PW; echo
    [ ${#PW} -ge 8 ] && break; red "太短了"
  done
  read -rp "DeepSeek API Key（sk-...，可先留空）: " KEY
  cp .env.example .env
  SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  esc() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }
  sed -i "s|^DOMAIN=.*|DOMAIN=$(esc "$DOMAIN")|" .env
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$(esc "$PW")|" .env
  sed -i "s|^SECRET_KEY=.*|SECRET_KEY=$SECRET|" .env
  sed -i "s|^LLM_API_KEY=.*|LLM_API_KEY=$(esc "$KEY")|" .env
  chmod 600 .env
fi

DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2-)

# 3. 检查 DNS 是否已指向本机（证书申请需要）
MYIP=$(curl -fsS --max-time 5 https://api.ipify.org || true)
DNSIP=$(getent hosts "$DOMAIN" | awk '{print $1; exit}' || true)
if [ -n "$MYIP" ] && [ "$MYIP" != "$DNSIP" ]; then
  red "注意：$DOMAIN 解析到 '${DNSIP:-无}'，本机公网 IP 是 $MYIP。"
  red "DNS 未生效时 HTTPS 证书会申请失败（生效后 Caddy 会自动重试）。"
fi

# 4. 启动
mkdir -p data backups
green ">> 构建并启动 ..."
docker compose up -d --build
docker image prune -f >/dev/null 2>&1 || true

green ">> 完成！稍等半分钟证书签发后，用手机 Chrome 打开： https://$DOMAIN"
green "   查看日志：docker compose logs -f app"
