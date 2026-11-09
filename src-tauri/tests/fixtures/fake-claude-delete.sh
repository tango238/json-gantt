#!/bin/sh
# Fake claude: deletes ./gantt.json.
[ -n "$FAKE_CLAUDE_ARGS_LOG" ] && printf "%s\n" "$*" >> "$FAKE_CLAUDE_ARGS_LOG"
rm -f gantt.json
exit 0
