#!/bin/sh
# Fake claude: reports cwd and whether CLAUDECODE is visible.
[ -n "$FAKE_CLAUDE_ARGS_LOG" ] && printf "%s\n" "$*" >> "$FAKE_CLAUDE_ARGS_LOG"
printf 'CWD=%s\n' "$(pwd -P)"
if [ -n "${CLAUDECODE+x}" ]; then echo CLAUDECODE=set; else echo CLAUDECODE=unset; fi
printf 'PATH=%s\n' "$PATH"
exit 0
