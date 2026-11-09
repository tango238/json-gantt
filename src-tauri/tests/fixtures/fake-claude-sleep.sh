#!/bin/sh
# Fake claude: spawns a background sleep and waits (for stop tests).
[ -n "$FAKE_CLAUDE_ARGS_LOG" ] && printf "%s\n" "$*" >> "$FAKE_CLAUDE_ARGS_LOG"
printf '%s\n' '{"type":"system","subtype":"init"}'
sleep 30 &
echo $! > sleep.pid
wait
