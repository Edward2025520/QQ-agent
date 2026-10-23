#!/usr/bin/env bash
# 安装 modules/ 下的插件与技能到 QQ-agent 安装目录。
# 默认 dry-run：只打印将要做什么。加 --apply 才真的复制。
set -euo pipefail

APP_DIR="/opt/qq-agent"
APPLY=0
SYSTEMD=0
MODULE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
用法: install.sh [选项]

  --app-dir <路径>   QQ-agent 安装目录（默认 /opt/qq-agent）
  --apply            真的复制（不加只打印计划）
  --systemd          顺带安装 qq-agent-retention 的 systemd 服务与定时器（需要 root）
  -h, --help         显示本帮助

示例:
  ./install.sh --app-dir /opt/qq-agent
  sudo ./install.sh --app-dir /opt/qq-agent --apply --systemd
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir) APP_DIR="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --systemd) SYSTEMD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ ! -d "$APP_DIR" ]]; then
  echo "安装目录不存在: $APP_DIR" >&2
  exit 1
fi
if [[ ! -d "$APP_DIR/plugins" || ! -d "$APP_DIR/skills" ]]; then
  echo "看起来不是 QQ-agent 安装目录（缺 plugins/ 或 skills/）: $APP_DIR" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"

copy_module() {
  local src="$1" dest_dir="$2" name
  name="$(basename "$src")"
  local dest="$dest_dir/$name"
  if [[ -e "$dest" ]]; then
    echo "  备份 $dest -> $dest.bak.$STAMP"
    if [[ $APPLY -eq 1 ]]; then cp -a "$dest" "$dest.bak.$STAMP"; fi
  fi
  echo "  复制 $src -> $dest"
  if [[ $APPLY -eq 1 ]]; then cp -a "$src" "$dest"; fi
}

echo "安装目录: $APP_DIR"
echo "模式: $([[ $APPLY -eq 1 ]] && echo 执行 || echo dry-run)"

echo "[1/3] 插件"
for src in "$MODULE_DIR"/plugins/*/; do
  [[ -d "$src" ]] || continue
  copy_module "${src%/}" "$APP_DIR/plugins"
done

echo "[2/3] 技能"
for src in "$MODULE_DIR"/skills/*/; do
  [[ -d "$src" ]] || continue
  copy_module "${src%/}" "$APP_DIR/skills"
done

echo "[3/3] 清理脚本"
if [[ $SYSTEMD -eq 1 ]]; then
  echo "  安装 /usr/local/bin/qq-agent-retention"
  echo "  安装 systemd 单元并 enable --now"
  if [[ $APPLY -eq 1 ]]; then
    install -m 755 "$MODULE_DIR/scripts/qq-agent-retention" /usr/local/bin/qq-agent-retention
    sed "s#/opt/qq-agent#$APP_DIR#g" "$MODULE_DIR/scripts/qq-agent-retention.service" > /etc/systemd/system/qq-agent-retention.service
    cp "$MODULE_DIR/scripts/qq-agent-retention.timer" /etc/systemd/system/qq-agent-retention.timer
    systemctl daemon-reload
    systemctl enable --now qq-agent-retention.timer
  fi
else
  echo "  跳过（未加 --systemd）。手动安装见 README。"
fi

if [[ $APPLY -eq 0 ]]; then
  echo
  echo "以上是计划。加 --apply 执行。"
fi
