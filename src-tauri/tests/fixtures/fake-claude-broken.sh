#!/bin/sh
# Fake claude: writes invalid JSON to ./gantt.json.
[ -n "$FAKE_CLAUDE_ARGS_LOG" ] && printf "%s\n" "$*" >> "$FAKE_CLAUDE_ARGS_LOG"
printf '%s' '{ not json' > gantt.json
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"broken"}'
exit 0
