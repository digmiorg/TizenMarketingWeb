#!/usr/bin/env bash
# Build, sign and optionally install the clock probe (config.xml says why it
# exists). Mirrors lab/avplay-probe/build.sh in the parts that matter: staged
# copy, `tizen package`, a signature check on the product, and the target
# resolved from the connected device rather than hardcoded.
#
#   ./build.sh            build and sign into .build/
#   ./build.sh install    ...and install + launch on the one connected panel
set -euo pipefail
case "${1:-}" in
  "" | install) ;;
  *) echo "unknown argument: $1 (expected nothing, or 'install')" >&2; exit 1 ;;
esac
HERE="$(cd "$(dirname "$0")" && pwd)"
TIZEN="${TIZEN:-$HOME/tizen-studio/tools/ide/bin/tizen}"
SDB="${SDB:-$HOME/tizen-studio/tools/sdb}"
PROFILE="${PROFILE:-Digmi_Samsung_Partner_2026}"
STAGE="$HERE/.build/stage"
rm -rf "$HERE/.build"
mkdir -p "$STAGE"
cp "$HERE/config.xml" "$HERE/index.html" "$HERE/icon.png" "$STAGE/"
"$TIZEN" package -t wgt -s "$PROFILE" -- "$STAGE" >/dev/null
WGT="$(ls -t "$STAGE"/*.wgt 2>/dev/null | head -1 || true)"
[ -n "$WGT" ] || { echo "package produced no .wgt" >&2; exit 1; }
LISTING="$(unzip -l "$WGT")"
case "$LISTING" in
  *signature1.xml*) ;;
  *) echo "the .wgt is unsigned (no signature1.xml): profile '$PROFILE' missing?" >&2; exit 1 ;;
esac
OUT="$HERE/.build/DigmiClockProbe.wgt"
mv "$WGT" "$OUT"
echo "built $OUT"
[ "${1:-}" = install ] || exit 0
TARGETS="$("$SDB" devices 2>/dev/null | awk '/device/ && !/List of/ {print $1}')"
COUNT="$(printf '%s\n' "$TARGETS" | grep -c . || true)"
[ "$COUNT" = 1 ] || { echo "need exactly one connected panel, found $COUNT" >&2; exit 1; }
"$TIZEN" install -n "$(basename "$OUT")" -s "$TARGETS" -- "$HERE/.build" | grep -E 'install completed|Fail|successfully' || true
"$TIZEN" run -p DgmiLab002.ClockProbe -s "$TARGETS" | grep -E 'launched|Fail|successfully' || true
