#!/usr/bin/env bash
#
# Print the identity that decides whether a display will accept an update of
# this .wgt: the SHA-256 of the author's public key. Prints `none` when the
# package carries no author signature.
#
# The public key, NOT the certificate around it. Samsung issues a renewal as a
# new author certificate over the existing RSA key, and says what that is for:
# "Samsung will issue a new author certificate for you using the same RSA key
# as in existing author certificate. You will be able to update your existing
# app [even] if your current author certificate is expired already", and
# "This renewed certificate will be the same as your original RSA key so
# upgrading your application is guaranteed."
#   https://developer.samsung.com/galaxy-watch-tizen/getting-certificates/extend.html
#   https://developer.samsung.com/galaxy-watch-tizen/getting-certificates/create.html
# Hashing the certificate instead would report a routine renewal as a new
# identity, and the release gate would then tell whoever is holding the
# certificate that every screen in the field needs a manual reinstall — at
# exactly the moment that is false and the advice is expensive. The certificate
# hash is still printed, on stderr, because it is what identifies a particular
# certificate in a log or in BUILD.md's table.
#
# Usage: scripts/author-identity.sh <package.wgt>

set -euo pipefail

PKG="${1:?usage: author-identity.sh <package.wgt>}"
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

cert_sha="$(openssl dgst -sha256 -r "$WORK/author.der" | cut -d' ' -f1)"
echo "certificate sha256:$cert_sha" >&2

# -pubkey emits the SubjectPublicKeyInfo as PEM; `pkey -outform DER` turns that
# back into the same DER bytes any renewal over this key would carry.
openssl x509 -inform DER -in "$WORK/author.der" -pubkey -noout \
    | openssl pkey -pubin -outform DER \
    | openssl dgst -sha256 -r \
    | cut -d' ' -f1
