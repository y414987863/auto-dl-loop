#!/usr/bin/env bash
# 角色运行时：以 root 启动，先把角色装进项目，再把控制权交给官方入口（由它 chown 挂载卷并降权到 paseo 运行 daemon 和 agent）。
set -euo pipefail

role="${ARL_ROLE:?ARL_ROLE must be worker or validator}"
project="${ARL_PROJECT_DIR:-/workspace/$role}"
checkout="${ARL_CHECKOUT:-/opt/arl}"
state_dir="/home/paseo/.arl-state"
stamp="$state_dir/$role"

if [ "$role" != "worker" ] && [ "$role" != "validator" ]; then
  echo "ARL_ROLE must be worker or validator, got '$role'" >&2
  exit 1
fi

# /home/paseo 是挂载卷，镜像里写在它下面的状态运行期都会被遮住。
mkdir -p "$state_dir" "$project"
chown paseo:paseo "$state_dir" "$project" 2>/dev/null || true

# worker 会把经验写回 /opt/arl，所以它必须属于 paseo 且是个可用的 Git 仓库。
# 属主不对时 Git 会拒绝操作（dubious ownership），root 也不能留下 root 属主的对象。
chown -R paseo:paseo "$checkout" 2>/dev/null || true
git config --global --get-all safe.directory 2>/dev/null | grep -qx "$checkout" \
  || git config --global --add safe.directory "$checkout"
gosu paseo git config --global --get-all safe.directory 2>/dev/null | grep -qx "$checkout" \
  || gosu paseo git config --global --add safe.directory "$checkout"
if [ ! -d "$checkout/.git" ]; then
  # 显式 main：经验的 experience 分支从 main 开，裸 git init 会落到 master。
  gosu paseo git -C "$checkout" init -q -b main
  gosu paseo git -C "$checkout" -c user.email=paseo@arl -c user.name=paseo add -A
  gosu paseo git -C "$checkout" -c user.email=paseo@arl -c user.name=paseo commit -qm "ARL runtime snapshot"
  gosu paseo git -C "$checkout" branch -m main 2>/dev/null || true
fi

# install.json 记录了角色，所以已装过的项目保持原角色，只有首次或显式修复才重装。
if [ "${ARL_FORCE_INSTALL:-0}" = "1" ] || [ ! -f "$project/.aris/install.json" ]; then
  echo "installing ARL role '$role' into $project"
  if ! gosu paseo bash "$checkout/distribution/install-aris.sh" --role "$role" --project "$project"; then
    echo "ARL installation failed; the Paseo daemon will still start." >&2
    echo "Run again with ARL_FORCE_INSTALL=1, or install inside the running container:" >&2
    echo "  docker exec -it --user root <container> bash $checkout/distribution/install-aris.sh --role $role --project $project" >&2
  else
    gosu paseo node "$project/.aris/dist/tools/setup-cli.js" apply --project "$project" >/dev/null 2>&1 || true
    # 每次提交都对应一个 Git commit，所以项目要有初始 commit；分支钉在 main。
    gosu paseo bash -c "
      cd '$project' || exit 1
      git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main
      git rev-parse --verify HEAD >/dev/null 2>&1 || {
        git add -A
        git -c user.email=paseo@arl -c user.name=paseo commit -qm 'ARL role $role installed' || true
      }
    " || true
  fi
  touch "$stamp"
else
  echo "ARL role '$role' already installed in $project"
fi

# 确保 agent 配置目录属主对（可能被 root 误创建，或挂载卷属主不对）
for d in /home/paseo/.codex /home/paseo/.claude /home/paseo/.paseo; do
  [ -d "$d" ] && chown -R paseo:paseo "$d" 2>/dev/null || true
done

# Codex 配置：从环境变量生成 config.toml 和 auth.json（validator）；缺失的变量写空串
if [ "$role" = "validator" ]; then
  mkdir -p /home/paseo/.codex
  cat > /home/paseo/.codex/auth.json <<EOF
{
  "OPENAI_API_KEY": "${OPENAI_API_KEY:-}"
}
EOF
  cat > /home/paseo/.codex/config.toml <<EOF
model_provider = "custom"
model = "${OPENAI_MODEL:-gpt-5.5}"
# 容器本身已经是隔离边界，不需要内部再套 bwrap sandbox
sandbox = "danger-full-access"

[model_providers.custom]
name = "custom"
base_url = "${OPENAI_BASE_URL:-https://api.openai.com/v1}"
wire_api = "responses"
requires_openai_auth = true
EOF
  chown -R paseo:paseo /home/paseo/.codex
fi

# Claude Code 配置：从环境变量生成 settings.json（worker）；缺失的变量写空串
if [ "$role" = "worker" ]; then
  mkdir -p /home/paseo/.claude
  cat > /home/paseo/.claude/settings.json <<EOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "${ANTHROPIC_BASE_URL:-https://api.anthropic.com}",
    "ANTHROPIC_AUTH_TOKEN": "${ANTHROPIC_AUTH_TOKEN:-}",
    "ANTHROPIC_MODEL": "${ANTHROPIC_MODEL:-claude-opus-5}",
    "ANTHROPIC_SMALL_FAST_MODEL": "${ANTHROPIC_SMALL_FAST_MODEL:-claude-haiku-4-5-20251001}"
  },
  "permissions": {
    "defaultMode": "bypassPermissions"
  },
  "skipDangerousModePermissionPrompt": true
}
EOF
  chown -R paseo:paseo /home/paseo/.claude
fi

exec /usr/local/bin/paseo-docker-entrypoint "$@"
