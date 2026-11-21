#!/usr/bin/env bash
# 安装 / 卸载 steam-game-presence 的 systemd 用户服务
# 用法见 --help

set -euo pipefail

UNIT_NAME="steam-game-presence.service"
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"

ACTION="install"
DRY_RUN=0
DO_LINGER=0

usage() {
  cat <<'EOF'
用法：./install-systemd.sh [选项]

  （无参数）      安装 unit、enable 并启动服务
  --linger        安装后顺带开启 linger（开机未登录也运行，可能需要 sudo）
  --status        查看服务状态和最近日志
  --uninstall     停止、禁用并删除 unit（保留 config.json 和 token）
  --dry-run       只打印将要写入的 unit 和路径，不做修改
  -h, --help      显示帮助
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --linger) DO_LINGER=1 ;;
    --uninstall) ACTION="uninstall" ;;
    --status) ACTION="status" ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "未知参数：$arg" >&2
      usage
      exit 1
      ;;
  esac
done

find_node() {
  local candidates=()
  if [ -x /usr/bin/node ]; then
    candidates+=("/usr/bin/node")
  fi
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  for candidate in "${candidates[@]}"; do
    if "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

make_unit() {
  # WorkingDirectory= 不解析引号，空格用 \x20 转义，% 用 %% 转义
  local unit_dir="${PROJECT_DIR//%/%%}"
  unit_dir="${unit_dir// /\\x20}"
  cat <<EOF
[Unit]
Description=Steam game presence daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$unit_dir
ExecStart="$NODE_BIN" "$PROJECT_DIR/src/index.js"
Restart=on-failure
RestartSec=10
StandardInput=null
SyslogIdentifier=steam-presence
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF
}

resolve_token_file() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const path = require("path");
    const root = process.argv[1];
    let token = path.join(root, "data", "steam-token.json");
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
      if (cfg.steam && cfg.steam.tokenFile) {
        token = path.resolve(root, cfg.steam.tokenFile);
      }
    } catch {}
    process.stdout.write(token);
  ' "$PROJECT_DIR"
}

if [ "$ACTION" = "status" ]; then
  systemctl --user --no-pager --full status "$UNIT_NAME" || true
  echo
  echo "最近日志："
  journalctl --user -u "$UNIT_NAME" -n 30 --no-pager || true
  exit 0
fi

if [ "$ACTION" = "uninstall" ]; then
  systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
  if [ -f "$UNIT_PATH" ]; then
    rm -f -- "$UNIT_PATH"
    echo "✔ 已删除 $UNIT_PATH"
  else
    echo "· unit 不存在，跳过删除"
  fi
  systemctl --user daemon-reload 2>/dev/null || true
  echo "✔ 已卸载（config.json、token 和项目文件都保留）"
  exit 0
fi

# ---- 安装 ----

if ! NODE_BIN="$(find_node)"; then
  echo "❌ 找不到 Node.js（需要 >= 18）。先安装 Node，或确认 /usr/bin/node 可用。" >&2
  exit 1
fi

if [ ! -f "$PROJECT_DIR/config.json" ]; then
  echo "❌ 没有 config.json。先执行：" >&2
  echo "   cd \"$PROJECT_DIR\"" >&2
  echo "   cp config.example.json config.json   # 然后编辑游戏列表" >&2
  exit 1
fi

TOKEN_FILE="$(resolve_token_file)"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "项目目录：$PROJECT_DIR"
  echo "Node：    $NODE_BIN"
  echo "Unit：    $UNIT_PATH"
  echo "Token：   $TOKEN_FILE ($([ -f "$TOKEN_FILE" ] && echo 已存在 || echo 未找到))"
  echo
  echo "----- unit 内容 -----"
  make_unit
  echo "---------------------"
  echo "[dry-run] 未做任何修改。"
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "❌ 找不到 systemctl，这台机器可能没有 systemd。" >&2
  exit 1
fi

if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "❌ 当前用户没有可用的 systemd 实例。" >&2
  echo "   桌面会话里直接运行即可；SSH/容器环境先试：" >&2
  echo "   loginctl enable-linger $USER" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"

if [ -f "$UNIT_PATH" ] && ! diff -q <(make_unit) "$UNIT_PATH" >/dev/null 2>&1; then
  BACKUP="$UNIT_PATH.bak.$(date +%Y%m%d-%H%M%S)"
  cp -a -- "$UNIT_PATH" "$BACKUP"
  echo "· 旧 unit 已备份：$BACKUP"
fi

make_unit > "$UNIT_PATH"
chmod 644 "$UNIT_PATH"
systemctl --user daemon-reload
echo "✔ unit 已写入：$UNIT_PATH"

if [ ! -f "$TOKEN_FILE" ]; then
  echo
  echo "⚠ 还没有 Steam token，unit 已写入但未启用（避免服务反复重启）。"
  echo "  1) cd \"$PROJECT_DIR\" && npm run login"
  echo "  2) ./install-systemd.sh"
  exit 0
fi

systemctl --user enable "$UNIT_NAME" >/dev/null
systemctl --user restart "$UNIT_NAME"
sleep 2

if systemctl --user is-active --quiet "$UNIT_NAME"; then
  echo "✔ 服务已启动并设为开机自启"
else
  echo "⚠ 服务启动失败，最近日志：" >&2
  journalctl --user -u "$UNIT_NAME" -n 25 --no-pager >&2 || true
  exit 1
fi

if [ "$DO_LINGER" -eq 1 ]; then
  if loginctl enable-linger "$USER" 2>/dev/null; then
    echo "✔ 已开启 linger：未登录图形界面也会运行"
  else
    echo "⚠ 开启 linger 失败，手动执行：sudo loginctl enable-linger $USER"
  fi
fi

echo
echo "查看日志：journalctl --user -u $UNIT_NAME -f"
