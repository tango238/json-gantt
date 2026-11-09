#!/bin/sh
# Fake claude: ignores SIGTERM (so does its background sleep); only SIGKILL stops it.
[ -n "$FAKE_CLAUDE_ARGS_LOG" ] && printf "%s\n" "$*" >> "$FAKE_CLAUDE_ARGS_LOG"
trap '' TERM
printf '%s\n' '{"type":"system","subtype":"init"}'
sleep 30 &
echo $! > sleep.pid
while :; do sleep 1; done
