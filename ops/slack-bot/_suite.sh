#!/bin/bash
# Count passes and failures from ONE execution -- running the script per
# grep gave divergent numbers, since these make real model calls.
for t in "$@"; do
  out=$(node "$t.js" 2>&1 | grep -vE "^config:")
  ok=$(printf '%s' "$out" | grep -c "^OK ")
  xx=$(printf '%s' "$out" | grep -c "^XX ")
  printf "%-16s %2s passed / %s failed\n" "$t" "$ok" "$xx"
  [ "$xx" != "0" ] && printf '%s\n' "$out" | grep "^XX " | sed 's/^/    /'
done
exit 0
