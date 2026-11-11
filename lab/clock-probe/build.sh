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
"$TIZEN" package -t wgt -s "$PROFILE" -- "$STAGE"
WGT="$(ls -t "$STAGE"/*.wgt 2>/dev/null | head -1 || true)"
[ -n "$WGT" ] || { echo "package produced no .wgt" >&2; exit 1; }
LISTING="$(unzip -l "$WGT")"
for SIG in author-signature.xml signature1.xml; do
  case "$LISTING" in
    *"$SIG"*) ;;
    *) echo "the .wgt is unsigned (no $SIG): profile '$PROFILE' missing?" >&2; exit 1 ;;
  esac
done
OUT="$HERE/.build/DigmiClockProbe.wgt"
mv "$WGT" "$OUT"
echo "built $OUT"
[ "${1:-}" = install ] || exit 0
[ -x "$SDB" ] || { echo "sdb not found at $SDB" >&2; exit 1; }
DEVICES="$("$SDB" devices 2>&1 || true)"
# The state field, not a substring: a panel named "device-x" must not count twice.
TARGETS="$(printf '%s\n' "$DEVICES" | awk '$2 == "device" {print $1}')"
COUNT="$(printf '%s\n' "$TARGETS" | grep -c . || true)"
[ "$COUNT" = 1 ] || {
  echo "need exactly one connected panel, found $COUNT. sdb said:" >&2
  printf '%s\n' "$DEVICES" >&2
  echo "(a wedged sdb: sdb kill-server && sdb start-server && sdb connect <ip>)" >&2
  exit 1
}
INSTALL="$("$TIZEN" install -n "$(basename "$OUT")" -s "$TARGETS" -- "$HERE/.build" 2>&1 || true)"
case "$INSTALL" in
  *"install completed"*) printf '%s\n' "$INSTALL" | grep -E 'install completed|successfully' ;;
  *)
    echo "install did not complete; not launching. tizen said:" >&2
    printf '%s\n' "$INSTALL" >&2
    exit 1
    ;;
esac
RUN="$("$TIZEN" run -p DgmiLab002.ClockProbe -s "$TARGETS" 2>&1 || true)"
case "$RUN" in
  *"successfully launched"*) printf '%s\n' "$RUN" | grep -E 'launched' ;;
  *)
    echo "launch did not complete. tizen said:" >&2
    printf '%s\n' "$RUN" >&2
    exit 1
    ;;
esac
