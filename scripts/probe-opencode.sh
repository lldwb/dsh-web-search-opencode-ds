#!/usr/bin/env bash
#
# probe-opencode.sh - 验证 OpenCode 的 Anthropic 兼容 Messages 端点确实会运行
# DeepSeek 官方的服务端 `web_search` 工具。
#
# 于 2026-10-02 针对 https://opencode.ai/zen/go/v1 实测，并在此处复核：
#
#   1. 格式良好的请求                -> HTTP 200 + 真实的 web_search_tool_result
#   2. 同样的请求不带
#      x-opencode-session             -> HTTP 400 MissingSessionID
#   3. 同样的请求只带
#      "Authorization: Bearer"        -> HTTP 401 AuthError "Missing API key."
#
# 检查 2 和 3 正是本插件同时发送 `x-api-key` 与 `Authorization: Bearer`、并且总是在
# 客户端生成会话 id 的原因：OpenCode 没有会话创建端点，因此没有什么可以预先注册。
#
# 两个端点，同一套线上格式。插件的 `goMode` 开关只决定用哪一个，其余都不变：
#
#   go       https://opencode.ai/zen/go/v1   包月的 OpenCode Go 订阅
#   metered  https://opencode.ai/zen/v1      默认的按量计费 API
#
# 两者都已确认存在：对每个端点 GET .../models 都返回 200（Go 有 43 个 id，按量计费
# 有 85 个，而 Go 只有 37 个；`deepseek-v4-flash` 已从 Go 下架，只剩按量计费侧）。
# 按量计费端点会返回 **HTTP 402 "Insufficient account funds"** —— 这是账户事实，
# 不是路由损坏，也正是这里把 402 报告为资金问题而不是检查失败的原因。
#
# 用法：
#   OPENCODE_API_KEY=sk-... ./scripts/probe-opencode.sh ["你的查询词"] [go|metered]
#
# 环境变量：
#   OPENCODE_API_KEY      必填（OPENCODE_GO_API_KEY 可作为回退）
#   OPENCODE_MESSAGES_URL 直接覆盖端点
#   OPENCODE_MODEL        默认 deepseek-v4.1-flash
#   OPENCODE_TIMEOUT      默认 120（秒；一次搜索是一整轮模型调用）
#
# 退出码：0 = 所有检查都符合预期，1 = 有检查偏离预期，
#         2 = 缺少凭据或工具。

set -uo pipefail

MODE="${2:-go}"
case "$MODE" in
  go)      DEFAULT_ENDPOINT="https://opencode.ai/zen/go/v1/messages" ;;
  metered) DEFAULT_ENDPOINT="https://opencode.ai/zen/v1/messages" ;;
  *)       echo "错误：mode 必须是 'go' 或 'metered'，实际为 '$MODE'" >&2; exit 2 ;;
esac

ENDPOINT="${OPENCODE_MESSAGES_URL:-$DEFAULT_ENDPOINT}"
MODEL="${OPENCODE_MODEL:-deepseek-v4.1-flash}"
API_VERSION="${OPENCODE_API_VERSION:-2023-06-01}"
TIMEOUT="${OPENCODE_TIMEOUT:-120}"
USER_AGENT="dsh-web-search-opencode-ds/0.2.0"
QUERY="${1:-DeepSeek V4 Flash release date}"

API_KEY="${OPENCODE_API_KEY:-${OPENCODE_GO_API_KEY:-}}"
if [ -z "$API_KEY" ]; then
  cat >&2 <<'EOF'
错误：没有 API 密钥。
  export OPENCODE_API_KEY=sk-...
  （或 OPENCODE_GO_API_KEY）。请在 https://opencode.ai/auth 订阅并复制密钥 ——
  注意 Go 套餐与按量计费 API 是同一账户上的两种独立权益。
EOF
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "错误：在 PATH 上找不到 curl" >&2
  exit 2
fi

WORK="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/probe-opencode.$$")"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

REQ_BODY="$WORK/request.json"
RESP_BODY="$WORK/response.json"
RESP_ERR="$WORK/curl.err"

# ---------------------------------------------------------------- 辅助函数 ----

new_uuid() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  elif command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr 'A-Z' 'a-z'
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import uuid; print(uuid.uuid4())'
  elif command -v node >/dev/null 2>&1; then
    node -e 'console.log(crypto.randomUUID())'
  else
    # 最后的兜底方案：不是真正的 v4，但网关只把该值当作不透明字符串。
    printf '%s-%s-%s' "$(date +%s)" "$$" "$RANDOM"
  fi
}

# 转义字符串，以便嵌入 JSON 的双引号字面量中。
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\r\n'
}

# run_case <标签> <期望状态码> [额外的 curl -H 参数...]
# 设置：CASE_STATUS、CASE_BODY
run_case() {
  local label="$1" expected="$2"
  shift 2

  CASE_STATUS="$(curl -sS --max-time "$TIMEOUT" -o "$RESP_BODY" -w '%{http_code}' \
    -X POST "$ENDPOINT" \
    -H 'Content-Type: application/json' \
    -H "anthropic-version: $API_VERSION" \
    -H 'x-opencode-client: dsh' \
    -H "User-Agent: $USER_AGENT" \
    "$@" \
    --data-binary "@$REQ_BODY" 2>"$RESP_ERR")" || true
  CASE_BODY="$(cat "$RESP_BODY" 2>/dev/null || true)"
  [ -n "$CASE_STATUS" ] || CASE_STATUS="000"

  local verdict="OK"
  if [ "$CASE_STATUS" != "$expected" ]; then
    if [ "$MODE" = "metered" ] && [ "$CASE_STATUS" = "402" ]; then
      # 路由正确、鉴权也通过了；只是账户没有按量计费余额。把它报告为一种独立结果，
      # 以免被误认为端点损坏，并且不因为它让整个探测失败。
      verdict="UNFUNDED(402)"
      UNFUNDED=1
    else
      verdict="DEVIATION"
      FAILED=1
    fi
  fi

  printf '%-46s 期望 %-4s 实际 %-4s  [%s]\n' "$label" "$expected" "$CASE_STATUS" "$verdict"
}

# ------------------------------------------------------------------ 探测 ----

FAILED=0
UNFUNDED=0
SESSION_ID="$(new_uuid)"

printf '端点 : %s\n' "$ENDPOINT"
printf '模式 : %s\n' "$MODE"
printf '模型 : %s\n' "$MODEL"
printf '会话 : %s\n' "$SESSION_ID"
printf '查询 : %s\n\n' "$QUERY"

cat > "$REQ_BODY" <<EOF
{"model":"$(json_escape "$MODEL")","max_tokens":2048,"messages":[{"role":"user","content":[{"type":"text","text":"Perform a web search for the query: $(json_escape "$QUERY")"}]}],"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":5}]}
EOF

echo '--- 传输层检查 -------------------------------------------------------'
run_case '1. x-api-key + Bearer + 会话头' 200 \
  -H "x-api-key: $API_KEY" -H "Authorization: Bearer $API_KEY" -H "x-opencode-session: $SESSION_ID"

run_case '2. 相同请求，但不带会话头' 400 \
  -H "x-api-key: $API_KEY" -H "Authorization: Bearer $API_KEY"

run_case '3. 仅 Bearer（不带 x-api-key），带会话头' 401 \
  -H "Authorization: Bearer $API_KEY" -H "x-opencode-session: $SESSION_ID"

echo
echo '--- 它真的会运行 DeepSeek 服务端 web_search 吗？ ----------------------'

if [ "$UNFUNDED" -eq 1 ]; then
  echo "SKIPPED: 按量计费账户没有余额（HTTP 402），因此没有可检查的"
  echo "         响应负载。路由与凭据都没有问题 ——"
  echo "         请充值，或改为探测 Go 套餐："
  echo "             ./scripts/probe-opencode.sh \"\$QUERY\" go"
else
  # 重跑用例 1，让 RESP_BODY 里是一次成功的响应体。
  run_case '4. 重跑用例 1 以检查响应负载' 200 \
    -H "x-api-key: $API_KEY" -H "Authorization: Bearer $API_KEY" -H "x-opencode-session: $(new_uuid)" \
    >/dev/null

  if grep -q '"web_search_tool_result"' "$RESP_BODY" 2>/dev/null; then
    RESULTS="$(grep -o '"type":"web_search_result"' "$RESP_BODY" | wc -l | tr -d ' ')"
    echo "PASS: 响应中包含 web_search_tool_result  （结果数：$RESULTS）"

    if grep -q '"server_tool_use"' "$RESP_BODY"; then
      echo "PASS: 响应中包含 server_tool_use（模型确实调用了 web_search）"
    fi
    if grep -q '"web_search_requests"' "$RESP_BODY"; then
      echo "PASS: 已上报 usage.server_tool_use.web_search_requests"
    fi
    if grep -q '"cited_text"' "$RESP_BODY"; then
      echo "NOTE: 存在 cited_text —— 该部署其实会输出摘要"
    else
      echo "NOTE: 响应负载中没有 cited_text/snippet；各项只带 title/url/page_age，"
      echo "      因此插件返回不带摘要的来源，而不是凭空编造一个。"
    fi

    echo
    echo '前几个来源：'
    grep -o '"url":"[^"]*"' "$RESP_BODY" | sed -e 's/^"url":"//' -e 's/"$//' | head -5 | sed 's/^/  - /'
  else
    echo "FAIL: 响应中没有 web_search_tool_result。"
    echo "      端点有响应，但没有运行服务端工具。"
    echo "      响应体前 400 字节："
    head -c 400 "$RESP_BODY" 2>/dev/null | sed 's/^/      /'
    echo
    FAILED=1
  fi
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "RESULT: 至少有一项检查偏离预期；见上方标记为 DEVIATION/FAIL 的行。"
  exit 1
fi
if [ "$UNFUNDED" -eq 1 ]; then
  echo "RESULT: 路由与鉴权都正确，但按量计费端点需要资金（HTTP 402）。"
  echo "        请使用 Go 套餐（插件默认）或为账户充值。"
  exit 0
fi
echo "RESULT: 所有检查都符合预期 —— 该端点支持 DeepSeek web_search。"
exit 0
