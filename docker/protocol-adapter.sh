#!/usr/bin/env bash
# Worker 协议转换器：在容器内跑 cc-switch，把 Claude Code 发出的 Anthropic
# Messages 请求转成 OpenAI Chat Completions 再发往上游（LLM 代理或真实供应商）。
#
# 只在 LLM4AD_UPSTREAM_API_FORMAT=openai_chat 时由 entrypoint 以 paseo 身份调用：
#   configure  按容器环境变量登记上游 provider（每次容器启动都重建配置）
#   serve      前台循环运行本地代理，进程退出后自动拉起
#   wait       等待本地代理就绪，超时返回非零
#
# cc-switch 会改写 Claude 的 settings.json，所以 HOME / CLAUDE_CONFIG_DIR 指向
# 独立目录，不碰 agent 真正使用的 /home/paseo/.claude。
set -euo pipefail

port="${LLM4AD_PROTOCOL_PROXY_PORT:-17821}"
root="/tmp/arl-cc-switch"
export HOME="$root/home"
export CLAUDE_CONFIG_DIR="$HOME/.claude"
export CC_SWITCH_CONFIG_DIR="$root"

configure() {
  local base_url="${ANTHROPIC_BASE_URL:?ANTHROPIC_BASE_URL is required}"
  local token="${ANTHROPIC_AUTH_TOKEN:?ANTHROPIC_AUTH_TOKEN is required}"
  local model="${ANTHROPIC_MODEL:?ANTHROPIC_MODEL is required}"
  local small_model="${ANTHROPIC_SMALL_FAST_MODEL:-$model}"
  local provider_file="$root/provider.json"

  rm -rf "$root"
  mkdir -p "$CLAUDE_CONFIG_DIR"
  chmod 700 "$root"
  # 用 jq 生成 JSON，避免 token / URL 里的特殊字符破坏格式
  jq -n \
    --arg base_url "$base_url" \
    --arg token "$token" \
    --arg model "$model" \
    --arg small_model "$small_model" \
    '{env: {
        ANTHROPIC_AUTH_TOKEN: $token,
        ANTHROPIC_BASE_URL: $base_url,
        ANTHROPIC_MODEL: $model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: $small_model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: $model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: $model
      }}' >"$provider_file"
  chmod 600 "$provider_file"

  # cc-switch 的输出可能回显配置内容，不打到容器日志里
  if ! cc-switch --app claude provider add \
      --name "LLM4AD Runtime" \
      --id llm4ad-runtime \
      --config-file "$provider_file" \
      --api-format openai_chat >/dev/null 2>&1; then
    echo "cc-switch provider add failed" >&2
    return 1
  fi
  if ! cc-switch --app claude provider switch llm4ad-runtime >/dev/null 2>&1; then
    echo "cc-switch provider switch failed" >&2
    return 1
  fi
}

serve() {
  while true; do
    cc-switch proxy serve --listen-address 127.0.0.1 --listen-port "$port" || true
    echo "cc-switch protocol adapter exited; restarting in 2s" >&2
    sleep 2
  done
}

wait_ready() {
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS -m 1 -o /dev/null "http://127.0.0.1:$port/health"; then
      return 0
    fi
    sleep 0.25
  done
  echo "cc-switch protocol adapter did not become ready on port $port" >&2
  return 1
}

case "${1:-}" in
  configure) configure ;;
  serve) serve ;;
  wait) wait_ready ;;
  *)
    echo "usage: $0 configure|serve|wait" >&2
    exit 2
    ;;
esac
