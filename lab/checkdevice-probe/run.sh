#!/usr/bin/env bash
# Serves src/ in a desktop browser with Tizen and the portal stubbed out, so
# checkDevice()'s polling lifecycle can be driven through states a bench panel
# cannot reach on demand: a rate-limited poll, an unpairing, a re-pairing, and a
# campaign unplanned mid-playback.
#
# Nothing here ships. It builds a throwaway copy of src/ in a temp directory
# because test.html has to sit NEXT TO js/ for the page's relative script tags
# to resolve, and the widget must not carry a test page into a .wgt.
#
#   ./lab/checkdevice-probe/run.sh [port]      # default 8761
#
# Then drive it from the browser console via window.__t -- see README.md.
set -euo pipefail

PORT="${1:-8761}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/../../src" && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/checkdevice-probe.XXXXXX")"

cp -R "$SRC/." "$OUT/"
cp "$HERE/stub.js" "$OUT/stub.js"

# index.html minus the two Tizen platform scripts (which 404 off-device and
# would leave window.tizen undefined before the stub can define it), plus
# stub.js ahead of main.js so the stub wins.
python3 - "$OUT" <<'PY'
import io, sys, os
out = sys.argv[1]
src = io.open(os.path.join(out, 'index.html'), encoding='utf-8').read()
for tag in ('<script type="text/javascript" src="$B2BAPIS/b2bapis/b2bapis.js"></script>',
            '<script type="text/javascript" src="$WEBAPIS/webapis/webapis.js"></script>'):
    if src.count(tag) != 1:
        raise SystemExit('index.html no longer carries this tag verbatim: ' + tag)
    src = src.replace(tag, '')
anchor = '<script src="js/main.js"></script>'
if src.count(anchor) != 1:
    raise SystemExit('index.html no longer loads js/main.js the way this probe expects')
src = src.replace(anchor, '<script src="stub.js"></script>\n    ' + anchor)
io.open(os.path.join(out, 'test.html'), 'w', encoding='utf-8').write(src)
PY

echo "probe root : $OUT"
echo "served main.js matches src: $(shasum -a 256 "$OUT/js/main.js" | cut -c1-16) vs $(shasum -a 256 "$SRC/js/main.js" | cut -c1-16)"
echo "open       : http://127.0.0.1:$PORT/test.html"
echo
echo "NOTE: use a FRESH port each time you change src/js/main.js, or the"
echo "browser serves the cached old file from the same origin and the run"
echo "measures the previous build. This bit me twice."
exec python3 -m http.server "$PORT" --directory "$OUT"
