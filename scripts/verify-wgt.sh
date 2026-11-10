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
# On a runner the point of a warning is the run summary, not line 140 of a log
# nobody opens. That is the whole reason the 90/30-day notice exists.
warn() {
    printf '  \033[33mwarn\033[0m  %s\n' "$1"
    [ -n "${GITHUB_ACTIONS:-}" ] && echo "::warning::$1"
    return 0
}

# `|| true`: head closes the pipe, and under pipefail that SIGPIPE becomes a
# failed script before the emptiness check below can report what is wrong.
wgt="$(find "$OUT_DIR" -maxdepth 1 -name '*.wgt' | head -1 || true)"
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
    -o -name '.settings' -o -name 'Build' -o -name 'Debug' -o -name '.sign' \
    -o -name '*.wgt' -o -name '*.test.js' \) 2>/dev/null || true)"
if [ -z "$stowaways" ]; then
    ok "no IDE or VCS metadata and no test files in the package"
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
# Printed, not asserted: a change of signing KEY is the thing that makes
# installed screens refuse an update, so it belongs in the build log where
# someone can compare it against the previous release. The certificate hash is
# printed beside it because that is what names one particular certificate, and
# because the two move independently: a renewal is a new certificate over the
# same key. Which of the two a display actually binds on is argued, with
# sources, at the top of scripts/author-identity.sh.
if [ -f "$WORK/pkg/author-signature.xml" ]; then
    # Written out rather than piped so the expiry check below can read the same
    # bytes without extracting them a second time.
    # -I: the package being verified is untrusted input, and an interpreter
    # that searches the current directory for its imports is one planted
    # json.py away from running someone else's code.
    python3 -I - "$WORK/pkg/author-signature.xml" "$WORK/author.der" <<'PY' || true
import base64, re, sys
xml = open(sys.argv[1]).read()
certs = re.findall(r'<[^>]*X509Certificate>\s*([A-Za-z0-9+/=\s]+?)\s*</[^>]*X509Certificate>', xml)
if certs:
    with open(sys.argv[2], 'wb') as f:
        f.write(base64.b64decode(re.sub(r'\s', '', certs[0])))
PY

    if [ ! -f "$WORK/author.der" ]; then
        # A signature with no certificate in it is one no display can bind
        # an author to, and one no gate here can compare.
        bad "author-signature.xml carries no X509Certificate"
    fi
    if [ -f "$WORK/author.der" ]; then
        # Both numbers, the same way round as everywhere else: the key is the
        # identity, the certificate is the label. Computed here rather than
        # through scripts/author-identity.sh, which answers for one at a time
        # and would mean unpacking the package twice more.
        # `|| true` on both: a present but unparseable certificate is a
        # finding, not a reason to abandon the run. Without it, pipefail inside
        # a command substitution takes the script down with a raw openssl error
        # and the summary below never prints.
        key_sha="$(openssl x509 -inform DER -in "$WORK/author.der" -pubkey -noout 2>/dev/null \
            | openssl pkey -pubin -outform DER 2>/dev/null \
            | openssl dgst -sha256 -r 2>/dev/null | cut -d' ' -f1 || true)"
        cert_sha="$(openssl dgst -sha256 -r "$WORK/author.der" 2>/dev/null | cut -d' ' -f1 || true)"
        if [ -n "$key_sha" ] && [ -n "$cert_sha" ]; then
            printf '  info  signing key  sha256:%s\n' "${key_sha:0:24}"
            printf '  info  certificate  sha256:%s\n' "${cert_sha:0:24}"
        else
            bad "the package carries an author signature whose certificate openssl cannot read"
        fi

        openssl x509 -inform DER -in "$WORK/author.der" -noout -subject -issuer -enddate \
            2>/dev/null | sed 's/^/          /' || true

        # A warning, not a failure: this build is signable today. What it cannot
        # do is wait. A renewal reuses the RSA key and keeps the estate
        # updatable, but it has to be done FROM that key, and the key only
        # opens with a password that has no reset. Miss the window and the next
        # release is signed by a new key, which a display refuses as a
        # different author — a site visit per screen.
        # -checkend is also true for a certificate that lapsed long ago, so
        # say both rather than promising it is still valid today.
        for days in 30 90; do
            if ! openssl x509 -inform DER -in "$WORK/author.der" \
                 -checkend $(( days * 86400 )) -noout >/dev/null 2>&1; then
                warn "the author certificate expires within $days days, or already has — renew it from the existing key (Certificate Manager: 'Use an existing author certificate'); a renewal over a new key is a different author, which means a manual reinstall on every installed screen"
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
