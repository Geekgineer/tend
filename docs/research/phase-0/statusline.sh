#!/bin/sh
# Spike status line: forward the JSON to the hook server, print a short line.
input=$(cat)
printf '%s' "$input" | curl -s -m 1 -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:4977/statusline >/dev/null 2>&1 &
printf '%s' "$input" | jq -r '"tend spike · ctx \(.context_window.used_percentage // "?")%"' 2>/dev/null || echo "tend spike"
