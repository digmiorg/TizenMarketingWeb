#!/usr/bin/env bash
#
# Print what identifies the author of a .wgt, or `none` when it carries no
# author signature:
#
#   scripts/author-identity.sh pkg.wgt         the author public key  (default)
#   scripts/author-identity.sh pkg.wgt cert    the author certificate
#
# The KEY is what the release gates compare, and the reasoning is worth stating
# because the two readings fail in opposite directions.
#
# Samsung issues a certificate renewal over the EXISTING RSA key, and says what
# that buys, unconditionally: "This renewed certificate will be the same as
# your original RSA key so upgrading your application is guaranteed."
#   https://developer.samsung.com/galaxy-watch-tizen/getting-certificates/create.html
# The companion page describes the same flow and is explicit about one route in
# particular: "In this process, Samsung will issue a new author certificate for
# you using the same RSA key as in existing author certificate. You will be
# able to update your existing app on Galaxy store if your current author
# certificate is expired already."
#   https://developer.samsung.com/galaxy-watch-tizen/getting-certificates/extend.html
#
# Note "on Galaxy store". That a renewal also keeps a SIDELOADED signage app
# updatable is an inference from the first quote, not something Samsung states
# about SSSP, and it has not been tried on a panel here. Elsewhere Samsung says
# only that "the update must be signed with the same author certificate as the
# original application", which is the loose phrasing the renewal pages
# resolve.
#
# So the gates compare keys AND report a changed certificate over an unchanged
# key as a warning rather than passing it in silence. Comparing certificates
# alone would call every routine renewal a new author and send someone to every
# screen in the field for nothing; comparing keys alone would wave a renewal
# through and, if a display does bind on the whole certificate, leave the fleet
# refusing updates with no warning anywhere. The warning is the part that does
# not pretend to know.

set -euo pipefail

PKG="${1:?usage: author-identity.sh <package.wgt> [key|cert]}"
WHAT="${2:-key}"
case "$WHAT" in
    key|cert) ;;
    *) echo "usage: author-identity.sh <package.wgt> [key|cert]" >&2; exit 2 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! unzip -o -q "$PKG" author-signature.xml -d "$WORK" 2>/dev/null; then
    echo none
    exit 0
fi

# -I: the package is untrusted input, and an interpreter that searches the
# current directory for its imports is one planted json.py away from running
# someone else's code in the job that holds the signing key.
if ! python3 -I - "$WORK/author-signature.xml" "$WORK/author.der" <<'PY'
import base64, re, sys

xml = open(sys.argv[1]).read()
certs = re.findall(r'<[^>]*X509Certificate>\s*([A-Za-z0-9+/=\s]+?)\s*</[^>]*X509Certificate>', xml)
if not certs:
    sys.exit(1)
# The first certificate in the chain is the author's; the rest are CAs.
with open(sys.argv[2], 'wb') as f:
    f.write(base64.b64decode(re.sub(r'\s', '', certs[0])))
PY
then
    echo none
    exit 0
fi

if [ "$WHAT" = cert ]; then
    openssl dgst -sha256 -r "$WORK/author.der" | cut -d' ' -f1
    exit 0
fi

# -pubkey emits the SubjectPublicKeyInfo as PEM; `pkey -outform DER` turns that
# back into the same DER bytes any renewal over this key would carry.
openssl x509 -inform DER -in "$WORK/author.der" -pubkey -noout \
    | openssl pkey -pubin -outform DER \
    | openssl dgst -sha256 -r \
    | cut -d' ' -f1
