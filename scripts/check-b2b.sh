#!/usr/bin/env bash
#
# The gates production/ gets from its two workflows, for the hand-published
# b2b/ channel: every b2b/<dir>/ that carries a descriptor passes
# verify-wgt.sh, and b2b/latest/ is byte-for-byte one of the version
# directories — the one with the highest <ver>, which is the only one a
# display following latest/ can be on. Run by the Verify b2b workflow on every
# pull request that touches b2b/, and by hand before committing.
#
# Usage: scripts/check-b2b.sh [b2b-dir]   (default: b2b)

set -euo pipefail

ROOT="${1:-b2b}"
here="$(cd "$(dirname "$0")" && pwd)"

[ -d "$ROOT" ] || { echo "no $ROOT/ directory"; exit 1; }

ver_of() {
    sed -n 's|.*<ver>\(.*\)</ver>.*|\1|p' "$1/sssp_config.xml" | head -1
}

fail=0
highest=''
highest_dir=''
for cfg in "$ROOT"/*/sssp_config.xml; do
    [ -f "$cfg" ] || continue
    dir="${cfg%/sssp_config.xml}"
    echo "== $dir"
    if ! "$here/verify-wgt.sh" "$dir"; then
        fail=1
        continue
    fi
    [ "$(basename "$dir")" = latest ] && continue
    ver="$(ver_of "$dir")"
    if ! [[ "$ver" =~ ^[0-9]+$ ]]; then
        echo "  FAIL  $dir advertises <ver>$ver</ver>, not an integer"
        fail=1
        continue
    fi
    if [ -z "$highest" ] || [ "$ver" -gt "$highest" ]; then
        highest="$ver"
        highest_dir="$dir"
    fi
done

if [ -d "$ROOT/latest" ] && [ -n "$highest_dir" ]; then
    echo "== $ROOT/latest must equal $highest_dir (<ver>$highest</ver>)"
    if diff -r "$ROOT/latest" "$highest_dir"; then
        echo "  ok    identical"
    else
        echo "  FAIL  $ROOT/latest differs from $highest_dir"
        fail=1
    fi
fi

[ "$fail" -eq 0 ] && echo "b2b/ looks consistent"
exit "$fail"
