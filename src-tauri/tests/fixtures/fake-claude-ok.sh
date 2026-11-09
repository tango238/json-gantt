#!/bin/sh
# Fake claude: replays probe.jsonl and renames the project in ./gantt.json (first "name" only).
[ -n "$FAKE_CLAUDE_ARGS_LOG" ] && printf "%s\n" "$*" >> "$FAKE_CLAUDE_ARGS_LOG"
dir=$(dirname "$0")
while IFS= read -r line; do
  printf '%s\n' "$line"
done < "$dir/probe.jsonl"
awk '!d && sub(/"name": "[^"]*"/, "\"name\": \"AI Edited\"") { d = 1 } { print }' gantt.json > gantt.tmp && mv gantt.tmp gantt.json
exit 0
