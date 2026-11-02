#!/usr/bin/env bash
#
# Print the SHA-256 of a .wgt's author certificate, or `none` when it carries
# no author signature.
#
# A Samsung display refuses an update signed by a different author identity
# than the one it already holds, and recovering from that means uninstalling
# and reinstalling the app on every screen in the field. The identity is
# therefore worth comparing before a release, not after.
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

python3 - "$WORK/author-signature.xml" <<'PY'
import base64, hashlib, re, sys

xml = open(sys.argv[1]).read()
certs = re.findall(r'<[^>]*X509Certificate>\s*([A-Za-z0-9+/=\s]+?)\s*</[^>]*X509Certificate>', xml)
# The first certificate in the chain is the author's; the rest are CAs.
print(hashlib.sha256(base64.b64decode(re.sub(r'\s', '', certs[0]))).hexdigest() if certs else 'none')
PY
