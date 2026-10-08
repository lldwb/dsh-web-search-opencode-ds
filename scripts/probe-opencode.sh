#!/usr/bin/env bash
#
# probe-opencode.sh - verify that OpenCode's Anthropic-compatible Messages
# endpoint really runs DeepSeek's official server-side `web_search` tool.
#
# Measured 2026-10-02 against https://opencode.ai/zen/go/v1, and re-checked here:
#
#   1. a well-formed request            -> HTTP 200 + real web_search_tool_result
#   2. same request without
#      x-opencode-session               -> HTTP 400 MissingSessionID
#   3. same request with only
#      "Authorization: Bearer"          -> HTTP 401 AuthError "Missing API key."
#
# Check 2 and 3 are why this plugin sends BOTH `x-api-key` and
# `Authorization: Bearer`, and always mints a client-side session id: OpenCode
# has no session-creation endpoint, so there is nothing to pre-register.
#
# TWO ENDPOINTS, one wire format. The plugin's `goMode` switch picks between them
# and nothing else changes:
#
#   go       https://opencode.ai/zen/go/v1   flat-rate OpenCode Go subscription
#   metered  https://opencode.ai/zen/v1      default pay-as-you-go API
#
# Both were confirmed to exist: GET .../models answers 200 on each (43 ids for
# Go, 85 for metered), and `deepseek-v4-flash` is listed in both catalogs. On an
# account with no metered balance the metered endpoint answers
# **HTTP 402 "Insufficient account funds"** - that is an account fact, not a
# broken route, and it is why a 402 here is reported as a funds problem rather
# than as a failed check.
#
# Usage:
#   OPENCODE_API_KEY=sk-... ./scripts/probe-opencode.sh ["your query"] [go|metered]
#
# Environment:
#   OPENCODE_API_KEY      required (OPENCODE_GO_API_KEY is accepted as a fallback)
#   OPENCODE_MESSAGES_URL override the endpoint outright
#   OPENCODE_MODEL        default deepseek-v4-flash
#   OPENCODE_TIMEOUT      default 120 (seconds; a search is a full model turn)
#
# Exit codes: 0 = all checks behaved as expected, 1 = a check deviated,
#             2 = missing credential or tooling.

set -uo pipefail

MODE="${2:-go}"
case "$MODE" in
  go)      DEFAULT_ENDPOINT="https://opencode.ai/zen/go/v1/messages" ;;
  metered) DEFAULT_ENDPOINT="https://opencode.ai/zen/v1/messages" ;;
  *)       echo "ERROR: mode must be 'go' or 'metered', got '$MODE'" >&2; exit 2 ;;
esac

ENDPOINT="${OPENCODE_MESSAGES_URL:-$DEFAULT_ENDPOINT}"
MODEL="${OPENCODE_MODEL:-deepseek-v4-flash}"
API_VERSION="${OPENCODE_API_VERSION:-2023-06-01}"
TIMEOUT="${OPENCODE_TIMEOUT:-120}"
USER_AGENT="dsh-web-search-opencode-ds/0.2.0"
QUERY="${1:-DeepSeek V4 Flash release date}"

API_KEY="${OPENCODE_API_KEY:-${OPENCODE_GO_API_KEY:-}}"
if [ -z "$API_KEY" ]; then
  cat >&2 <<'EOF'
ERROR: no API key.
  export OPENCODE_API_KEY=sk-...
  (or OPENCODE_GO_API_KEY). Subscribe and copy a key at https://opencode.ai/auth -
  note the Go plan and the metered API are separate entitlements on one account.
EOF
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl not found on PATH" >&2
  exit 2
fi

WORK="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/probe-opencode.$$")"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

REQ_BODY="$WORK/request.json"
RESP_BODY="$WORK/response.json"
RESP_ERR="$WORK/curl.err"

# ---------------------------------------------------------------- helpers ----

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
    # Last resort: not a real v4, but the gateway treats the value as opaque.
    printf '%s-%s-%s' "$(date +%s)" "$$" "$RANDOM"
  fi
}

# Escape a string for embedding in a JSON double-quoted literal.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\r\n'
}

# run_case <label> <expected-status> [extra curl -H args...]
# Sets: CASE_STATUS, CASE_BODY
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
      # The route is right and auth passed; the account simply has no metered
      # balance. Report it as a distinct outcome so it is not mistaken for a
      # broken endpoint, and do not fail the whole probe on it.
      verdict="UNFUNDED(402)"
      UNFUNDED=1
    else
      verdict="DEVIATION"
      FAILED=1
    fi
  fi

  printf '%-46s expected %-4s got %-4s  [%s]\n' "$label" "$expected" "$CASE_STATUS" "$verdict"
}

# ------------------------------------------------------------------ probe ----

FAILED=0
UNFUNDED=0
SESSION_ID="$(new_uuid)"

printf 'endpoint : %s\n' "$ENDPOINT"
printf 'mode     : %s\n' "$MODE"
printf 'model    : %s\n' "$MODEL"
printf 'session  : %s\n' "$SESSION_ID"
printf 'query    : %s\n\n' "$QUERY"

cat > "$REQ_BODY" <<EOF
{"model":"$(json_escape "$MODEL")","max_tokens":2048,"messages":[{"role":"user","content":[{"type":"text","text":"Perform a web search for the query: $(json_escape "$QUERY")"}]}],"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":5}]}
EOF

echo '--- transport checks -------------------------------------------------'
run_case '1. x-api-key + Bearer + session header' 200 \
  -H "x-api-key: $API_KEY" -H "Authorization: Bearer $API_KEY" -H "x-opencode-session: $SESSION_ID"

run_case '2. same, but NO session header' 400 \
  -H "x-api-key: $API_KEY" -H "Authorization: Bearer $API_KEY"

run_case '3. Bearer only (no x-api-key), with session' 401 \
  -H "Authorization: Bearer $API_KEY" -H "x-opencode-session: $SESSION_ID"

echo
echo '--- does it run DeepSeek server-side web_search? ---------------------'

if [ "$UNFUNDED" -eq 1 ]; then
  echo "SKIPPED: the metered account has no balance (HTTP 402), so there is no"
  echo "         payload to inspect. The route and the credential are both fine -"
  echo "         add funds, or probe the Go plan instead:"
  echo "             ./scripts/probe-opencode.sh \"\$QUERY\" go"
else
  # Re-run case 1 so RESP_BODY holds a successful payload.
  run_case '4. re-run case 1 for payload inspection' 200 \
    -H "x-api-key: $API_KEY" -H "Authorization: Bearer $API_KEY" -H "x-opencode-session: $(new_uuid)" \
    >/dev/null

  if grep -q '"web_search_tool_result"' "$RESP_BODY" 2>/dev/null; then
    RESULTS="$(grep -o '"type":"web_search_result"' "$RESP_BODY" | wc -l | tr -d ' ')"
    echo "PASS: response contains web_search_tool_result  (results: $RESULTS)"

    if grep -q '"server_tool_use"' "$RESP_BODY"; then
      echo "PASS: response contains server_tool_use (the model invoked web_search)"
    fi
    if grep -q '"web_search_requests"' "$RESP_BODY"; then
      echo "PASS: usage.server_tool_use.web_search_requests is reported"
    fi
    if grep -q '"cited_text"' "$RESP_BODY"; then
      echo "NOTE: cited_text present - this deployment emits snippets after all"
    else
      echo "NOTE: no cited_text/snippet in the payload; items carry title/url/page_age only,"
      echo "      so the plugin returns sources without a snippet rather than inventing one."
    fi

    echo
    echo 'first sources:'
    grep -o '"url":"[^"]*"' "$RESP_BODY" | sed -e 's/^"url":"//' -e 's/"$//' | head -5 | sed 's/^/  - /'
  else
    echo "FAIL: no web_search_tool_result in the response."
    echo "      The endpoint answered, but did not run the server-side tool."
    echo "      First 400 bytes of the body:"
    head -c 400 "$RESP_BODY" 2>/dev/null | sed 's/^/      /'
    echo
    FAILED=1
  fi
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "RESULT: at least one check deviated; see the lines marked DEVIATION/FAIL above."
  exit 1
fi
if [ "$UNFUNDED" -eq 1 ]; then
  echo "RESULT: routing and auth are correct, but the metered endpoint needs funds (HTTP 402)."
  echo "        Use the Go plan (the plugin's default) or top up the account."
  exit 0
fi
echo "RESULT: all checks behaved as expected - the endpoint supports DeepSeek web_search."
exit 0
