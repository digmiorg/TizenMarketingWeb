#!/usr/bin/env bash
#
# Check a built package the way a Samsung display would, before a display gets
# the chance to refuse it quietly.
#
# Every assertion here corresponds to a failure that is close to invisible in
# the field: the screen either keeps serving the old build, shows "Unable to
# start the app", or sits on the pairing page, and none of those say why.
#
# Usage: scripts/verify-wgt.sh <out-dir>

set -euo pipefail

OUT_DIR="${1:?usage: verify-wgt.sh <out-dir>}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=1; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; }

wgt="$(find "$OUT_DIR" -maxdepth 1 -name '*.wgt' | head -1)"
cfg="$OUT_DIR/sssp_config.xml"

[ -n "$wgt" ] || { echo "no .wgt in $OUT_DIR"; exit 1; }
[ -f "$cfg" ] || { echo "no sssp_config.xml in $OUT_DIR"; exit 1; }

echo "verifying $(basename "$wgt")"
unzip -o -q "$wgt" -d "$WORK/pkg"

# --- the package is signed ---------------------------------------------------
# An unsigned package is rejected outright, even in developer mode.
for f in author-signature.xml signature1.xml; do
    if [ -f "$WORK/pkg/$f" ]; then ok "$f present"; else bad "$f missing — package is not signed"; fi
done

# --- no metadata rode along --------------------------------------------------
# Tizen signs every file it finds, so IDE and VCS leftovers are signed as part
# of the app. Refused here because of what we ship, not because of a diagnosed
# field failure: the published 1.0.7 package carries .gitignore and Build/ and
# installed regardless.
stowaways="$(cd "$WORK/pkg" && find . \( -name '.git*' -o -name '.project' -o -name '.tproject' \
    -o -name '.settings' -o -name 'Build' -o -name 'Debug' -o -name '.sign' \) 2>/dev/null || true)"
if [ -z "$stowaways" ]; then
    ok "no IDE or VCS metadata in the package"
else
    bad "metadata found in the package:"
    echo "$stowaways" | sed 's/^/          /'
fi

# --- config.xml survived -----------------------------------------------------
if grep -q '<name>' "$WORK/pkg/config.xml"; then
    ok "config.xml has <name>"
else
    bad "config.xml has no <name> (Tizen Studio's GUI rewrites it as <n>)"
fi

if grep -q '<tizen:application' "$WORK/pkg/config.xml"; then
    ok "config.xml declares <tizen:application>"
else
    bad "config.xml is not a web application (<tizen:addon>?) — it will install but not start"
fi

# --- the descriptor matches the package --------------------------------------
declared_size="$(sed -n 's/.*<size>\([0-9]*\)<\/size>.*/\1/p' "$cfg" | head -1)"
actual_size="$(wc -c < "$wgt" | tr -d ' ')"
# Missing and wrong are different problems. The legacy descriptors in this
# repository have no <size> at all, so folding the two together would report
# them as a mismatch against an empty string and hide which one it is.
if [ -z "$declared_size" ]; then
    bad "<size> is absent — state it, exactly ($actual_size bytes)"
elif [ "$declared_size" = "$actual_size" ]; then
    ok "<size> matches the package ($actual_size bytes)"
else
    bad "<size> is $declared_size but the package is $actual_size bytes — the display will decline the download"
fi

declared_ver="$(sed -n 's/.*<ver>\([^<]*\)<\/ver>.*/\1/p' "$cfg" | head -1)"
if [[ "$declared_ver" =~ ^[0-9]+$ ]]; then
    ok "<ver> is an integer ($declared_ver)"
else
    bad "<ver> is '$declared_ver' — it must be an integer or the display never re-downloads"
fi

declared_name="$(sed -n 's/.*<widgetname>\([^<]*\)<\/widgetname>.*/\1/p' "$cfg" | head -1)"
config_name="$(sed -n 's/.*<name>\([^<]*\)<\/name>.*/\1/p' "$WORK/pkg/config.xml" | head -1)"
if [ "$declared_name" = "$config_name" ]; then
    ok "<widgetname> matches config.xml <name> ($config_name)"
else
    bad "<widgetname> is '$declared_name' but config.xml says '$config_name'"
fi

# --- the version it will report ----------------------------------------------
# A screen can only answer "do I have the fix?" through appVersion, so a build
# whose bundle and panel disagree is a build nobody can verify in a salon.
bundle_version="$(sed -n "s/.*const appVersion = '\([^']*\)'.*/\1/p" "$WORK/pkg/js/main.js" | head -1)"
config_version="$(sed -n 's/.*<widget[^>]* version="\([^"]*\)".*/\1/p' "$WORK/pkg/config.xml" | head -1)"
if [ "$bundle_version" = "$config_version" ]; then
    ok "appVersion matches config.xml version ($config_version)"
else
    bad "appVersion is $bundle_version but config.xml says $config_version"
fi

# --- the signing identity ----------------------------------------------------
# Printed, not asserted: a change of author certificate is the thing that makes
# installed screens refuse an update, so it belongs in the build log where
# someone can compare it against the previous release.
if [ -f "$WORK/pkg/author-signature.xml" ]; then
    # Written out rather than piped so the expiry check below can read the same
    # bytes without extracting them a second time.
    python3 - "$WORK/pkg/author-signature.xml" "$WORK/author.der" <<'PY' || true
import base64, hashlib, re, sys
xml = open(sys.argv[1]).read()
certs = re.findall(r'<[^>]*X509Certificate>\s*([A-Za-z0-9+/=\s]+?)\s*</[^>]*X509Certificate>', xml)
if certs:
    der = base64.b64decode(re.sub(r'\s', '', certs[0]))
    with open(sys.argv[2], 'wb') as f:
        f.write(der)
    print('  info  signed by sha256:' + hashlib.sha256(der).hexdigest()[:24])
PY

    if [ -f "$WORK/author.der" ]; then
        openssl x509 -inform DER -in "$WORK/author.der" -noout -subject -issuer -enddate \
            2>/dev/null | sed 's/^/          /' || true

        # A warning, not a failure: this build is signable today. What it cannot
        # do is wait. Re-signing after the certificate lapses means a NEW author
        # identity, and a Samsung display refuses an update signed by one — so
        # every screen in the field would need the app removed and reinstalled
        # by hand. Renewing while the current identity still signs costs
        # nothing; letting it expire costs a site visit per screen.
        for days in 30 90; do
            if ! openssl x509 -inform DER -in "$WORK/author.der" \
                 -checkend $(( days * 86400 )) -noout >/dev/null 2>&1; then
                warn "the author certificate expires within $days days — renew it BEFORE it lapses, or every installed screen needs a manual reinstall"
                break
            fi
        done
    fi
fi

echo
if [ "$fail" -eq 0 ]; then
    echo "package looks deployable"
else
    echo "package would fail on a display — not publishing"
    exit 1
fi
