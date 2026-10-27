#!/usr/bin/env bash
# claude-sessions·codex-sessions 를 상시 HTTP 서버 하나(launchd)로 설치·재시작한다.
#   bash scripts/install-http.sh
# Claude Code 등록(1회):
#   claude mcp add --scope user --transport http claude-sessions http://127.0.0.1:18766/claude-sessions/mcp
#   claude mcp add --scope user --transport http codex-sessions  http://127.0.0.1:18766/codex-sessions/mcp
# 소스(.ts)를 tsx 로 바로 읽으므로 코드 수정 후에는 이 스크립트를 다시 돌려 재시작한다.
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
LABEL=com.wonjp.sessions-mcp
PORT="${SESSIONS_MCP_PORT:-18766}"
NODE="${SESSIONS_MCP_NODE:-/opt/homebrew/bin/node}"
LOG_DIR="$HOME/Library/Logs/sessions-mcp"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--import</string>
    <string>tsx</string>
    <string>$APP_DIR/src/http.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>SESSIONS_MCP_PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/err.log</string>
</dict>
</plist>
EOF

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout 은 정리가 끝나기 전에 돌아올 수 있다. 서비스가 사라지고 포트가 빌 때까지 기다려야
# bootstrap 실패(5: Input/output error)나 옛 서버가 응답하는 거짓 OK 를 피한다.
for _ in $(seq 1 40); do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.25
done
for _ in $(seq 1 40); do lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.25; done
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "FAIL: 포트 $PORT 를 다른 프로세스가 쓰고 있다"; lsof -nP -iTCP:"$PORT" -sTCP:LISTEN; exit 1
fi
ok=0
for _ in 1 2 3 4 5; do
  launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && { ok=1; break; }
  sleep 1
done
[ "$ok" = 1 ] || { echo "FAIL: launchctl bootstrap 실패"; exit 1; }

URL="http://127.0.0.1:$PORT/claude-sessions/mcp"
for _ in $(seq 1 60); do
  curl -s -o /dev/null -H 'Content-Type: application/json' -d '{}' "$URL" && break
  sleep 0.5
done
curl -s -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$URL" \
  | grep -q sessions_search && echo "OK $LABEL → http://127.0.0.1:$PORT/{claude,codex}-sessions/mcp" \
  || { echo "FAIL: 응답 없음. $LOG_DIR 확인"; exit 1; }
