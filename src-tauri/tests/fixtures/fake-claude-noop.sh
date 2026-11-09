#!/bin/sh
# Fake claude: does nothing to gantt.json.
[ -n "$FAKE_CLAUDE_ARGS_LOG" ] && printf "%s\n" "$*" >> "$FAKE_CLAUDE_ARGS_LOG"
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"noop"}'
exit 0
