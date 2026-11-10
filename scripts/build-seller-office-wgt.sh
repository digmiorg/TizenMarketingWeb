#!/usr/bin/env bash
#
# Build the .wgt that is uploaded to TV Seller Office.
#
# This is NOT scripts/build-wgt.sh with different flags. The two channels are
# different enough that confusing them wastes an upload round trip:
#
#   build-wgt.sh             SSSP sideload. Signs with one of our own Samsung
#                            certificate profiles. A panel fetching that
#                            package over HTTP verifies the signature, so it
#                            has to be a real one.
#
#   build-seller-office-wgt  The store. Signs nothing and holds no certificate.
#   (this script)            The app is bound to an author certificate whose
#                            key nobody here holds, so `author-signature.xml`
#                            and `signature1.xml` are copied out of a package
#                            Seller Office has already accepted. Why that is
#                            accepted, and why it still installs on a customer's
#                            panel, is recorded in Notion with the measurements
#                            behind it.
#
# Three elements differ between the channels, and this script rewrites them in
# the staged copy rather than in src/: the Tizen ID, <name> and <tizen:profile>.
# All three are taken from the reference package, so "what the store expects"
# has one source of truth and it is a file Samsung accepted. src/config.xml
# keeps the SSSP values and explains why.
#
# WARNING: the package this produces will NOT install over SSSP or sdb. Its
# signature describes a different package, and a panel fetching it directly
# checks that. Prove the CONTENT on the bench with build-wgt.sh; upload this.
#
# WARNING: this route depends on the pre-test accepting a copied signature.
# Background, evidence and the durable alternative are in Notion DTD-2130 and
# the Seller Office task, deliberately not in this public repository.
#
# Usage: scripts/build-seller-office-wgt.sh <reference.wgt>
#   <reference.wgt>  the most recently accepted package, downloaded from
#                    Seller Office > Applications > App Package.

set -euo pipefail

REFERENCE="${1:?usage: build-seller-office-wgt.sh <reference.wgt>}"

SRC_DIR="src"
STAGE_DIR="${SO_STAGE_DIR:-.build/seller-office/package}"
OUT_DIR="${SO_OUT_DIR:-.build/seller-office/out}"
REF_DIR=".build/seller-office/reference"

# Both are wiped with `rm -rf` below, and both are overridable, so the guard
# that keeps the cleanup inside .build/ has to hold against more than a typo.
# It used to be a string prefix test (`case $dir in .build/*`), which is not
# enough on two counts, and each one reached the `rm -rf`:
#
#   * `.build/../src` matches the pattern and resolves to the source tree --
#     exactly the deletion the guard was added to prevent.
#   * `.build/` matches it too, because a trailing `*` also matches nothing,
#     which would take the reference directory down with it.
#
# So resolve first and compare resolved paths. `pwd -P` resolves symlinks, so a
# symlinked component cannot redirect the cleanup out of the tree either, and
# the target is required to be STRICTLY beneath .build/ rather than equal to it.
# Pure shell on purpose: this script has no other interpreter dependency.
#
# The directory need not exist yet, so resolve the deepest existing ancestor
# and re-append the part that does not exist.
resolve_path() {
    _rest=""
    _p="${1%/}"
    [ -n "$_p" ] || _p="/"
    while [ ! -d "$_p" ]; do
        _rest="${_p##*/}${_rest:+/}$_rest"
        case "$_p" in
            */*) _p="${_p%/*}"; [ -n "$_p" ] || _p="/" ;;
            *)   _p="." ;;
        esac
    done
    printf '%s\n' "$(cd "$_p" && pwd -P)${_rest:+/$_rest}"
}

assert_under_build() {
    _label="$1"
    _given="$2"
    _root="$(resolve_path .build)"
    _abs="$(resolve_path "$_given")"
    case "$_abs" in
        "$_root"/?*) ;;
        *) echo "$_label must resolve to a directory strictly beneath $_root; '$_given' resolves to '$_abs'" >&2; exit 1 ;;
    esac
}

assert_under_build SO_STAGE_DIR "$STAGE_DIR"
assert_under_build SO_OUT_DIR "$OUT_DIR"

say() { printf '==> %s\n' "$1"; }
die() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

read_version() { sed -n 's/.*<widget[^>]* version="\([^"]*\)".*/\1/p' "$1" | head -1; }
read_appid()   { sed -n 's/.*<tizen:application[^>]* id="\([^"]*\)".*/\1/p' "$1" | head -1; }
# <name> and <tizen:profile> are deliberately NOT read here. sed returns the
# raw bytes while the readback below decodes with a parser, so a title
# containing an entity (`Digmi &amp; Marketing`) would compare unequal although
# the bytes written were right, and the build would die blaming the rewrite.
# One extractor serves both sides instead: see the python block.

# Validated before use so that a malformed version produces its own diagnosis
# rather than a stream of `[: : integer expected` followed by a misleading
# "does not exceed" message.
#
# Three components exactly. Samsung's checklist allows a fourth for
# multi-architecture packages (1.0.0.1064); this repository does not build one,
# and admitting the format here would mean teaching the comparison about it.
#
# The ranges are the checklist's: [0-255].[0-255].[0-65535]. Note that
# build-wgt.sh is STRICTER for the SSSP channel, where minor and patch must
# both stay under 100 because they are folded into a single integer <ver>. A
# version this script accepts can therefore still be refused by the SSSP build;
# keeping both under 100 keeps the two channels on the same number.
require_semver() {
    local label="$1" v="$2" major minor patch
    # The length cap comes first: `test -le` overflows on a long digit run and
    # leaks a `[: integer expected` line before the range check can speak.
    # 255.255.65535 is 14 characters.
    [ "${#v}" -le 16 ] || die "$label version '$v' is too long to be major.minor.patch"
    case "$v" in
        *[!0-9.]* | *..* | .* | *. ) die "$label version '$v' is not major.minor.patch" ;;
    esac
    [ "$(printf '%s' "$v" | tr -cd . | wc -c | tr -d ' ')" = 2 ] \
        || die "$label version '$v' is not major.minor.patch"
    IFS=. read -r major minor patch <<<"$v"
    [ "$major" -le 255 ] && [ "$minor" -le 255 ] && [ "$patch" -le 65535 ] \
        || die "$label version '$v' is outside Samsung's [0-255].[0-255].[0-65535]"
}

# Plain integer comparison per component. `sort -V` is not available
# everywhere this runs, and string order puts 1.0.9 above 1.0.12.
version_gt() {
    local a b i a1 a2 a3 b1 b2 b3
    IFS=. read -r a1 a2 a3 <<<"$1"
    IFS=. read -r b1 b2 b3 <<<"$2"
    for i in 1 2 3; do
        eval "a=\$a$i; b=\$b$i"
        [ "$a" -gt "$b" ] && return 0
        [ "$a" -lt "$b" ] && return 1
    done
    return 1
}

[ -f "$REFERENCE" ] || die "$REFERENCE does not exist"

# REF_DIR is wiped below. A reference handed to us from inside it would be
# deleted before it could be read.
ref_abs="$(cd "$(dirname "$REFERENCE")" && pwd)/$(basename "$REFERENCE")"
case "$ref_abs" in
    "$(pwd)/$REF_DIR"/*) die "keep the reference outside $REF_DIR; that directory is wiped on each run" ;;
esac

# ------------------------------------------------------------- reference ---
say "reading the accepted package: $REFERENCE"
rm -rf "$REF_DIR"; mkdir -p "$REF_DIR"
unzip -o -q "$REFERENCE" -d "$REF_DIR" || die "$REFERENCE is not a readable zip"

for f in author-signature.xml signature1.xml config.xml; do
    [ -f "$REF_DIR/$f" ] || die "$REFERENCE has no $f; is it really a Seller Office package?"
done

# Attribute values only, which cannot carry entities in a Tizen config. The
# shell needs these two for the output filename and the overlap message.
ref_version="$(read_version "$REF_DIR/config.xml")"
ref_appid="$(read_appid   "$REF_DIR/config.xml")"
[ -n "$ref_version" ] || die "could not read version from the reference config.xml"
[ -n "$ref_appid" ]   || die "could not read the Tizen ID from the reference config.xml"
require_semver accepted "$ref_version"

say "  accepted $ref_version, Tizen ID $ref_appid"

# Name the identity being reused out loud, so whoever runs this sees whose
# stamp goes on the upload instead of taking a comment's word for it.
if command -v openssl >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
    python3 -I - "$REF_DIR/author-signature.xml" <<'PY' || true
import base64, re, subprocess, sys
d = open(sys.argv[1]).read()
m = re.search(r'<X509Certificate>(.*?)</X509Certificate>', d, re.S)
if m:
    der = base64.b64decode(''.join(m.group(1).split()))
    out = subprocess.run(['openssl', 'x509', '-inform', 'DER', '-noout',
                          '-subject', '-enddate'], input=der, capture_output=True)
    for line in out.stdout.decode().splitlines():
        print('  reusing author %s' % line.strip())
PY
fi

# ----------------------------------------------------------------- gates ---
version="$(read_version "$SRC_DIR/config.xml")"
[ -n "$version" ] || die "could not read version from $SRC_DIR/config.xml"
require_semver "$SRC_DIR/config.xml" "$version"

# The same gate build-wgt.sh applies: appVersion is the only version a screen
# displays, so a package whose bundle and panel disagree cannot be verified on
# site.
app_version="$(sed -n "s/.*const appVersion = '\([^']*\)'.*/\1/p" "$SRC_DIR/js/main.js" | head -1)"
[ -n "$app_version" ] || die "could not read appVersion from $SRC_DIR/js/main.js"
[ "$version" = "$app_version" ] \
    || die "version mismatch: config.xml says $version, main.js appVersion says $app_version"

# "When you upload a new package, it must not overlap with the version of the
# existing package."
version_gt "$version" "$ref_version" \
    || die "version $version does not exceed the accepted $ref_version; the pre-test refuses an overlap"

# The output filename. Derived from the store Tizen ID rather than <name>,
# which the store spells with a space. It is a filename and a shell word, so
# it is checked like one.
out_name="${ref_appid##*.}"
case "$out_name" in
    '' | .* | *[!A-Za-z0-9._-]* ) die "cannot build a filename from the Tizen ID '$ref_appid'" ;;
esac

say "building $version (over accepted $ref_version) as ${out_name}.wgt"

# ----------------------------------------------------------------- stage ---
# Identical hygiene to build-wgt.sh: whatever the IDE or git left behind would
# otherwise travel into the package.
say "staging a clean package directory"
rm -rf "$STAGE_DIR" "$OUT_DIR"
mkdir -p "$STAGE_DIR" "$OUT_DIR"
cp -R "$SRC_DIR"/. "$STAGE_DIR"/

find "$STAGE_DIR" -mindepth 1 \( -name '.*' -o -name Build -o -name Debug \) \
    -prune -exec rm -rf {} +
find "$STAGE_DIR" -name '*.wgt' -delete
# Tests sit beside the code they test. They are CommonJS, the panel has no
# loader for them, and in this channel they would travel all the way into a
# Samsung store listing. Same strip as build-wgt.sh.
find "$STAGE_DIR" -name '*.test.js' -delete
rm -f "$STAGE_DIR/author-signature.xml" "$STAGE_DIR/signature1.xml"

[ -f "$STAGE_DIR/config.xml" ] || die "config.xml missing from the staged package"
[ -f "$STAGE_DIR/index.html" ] || die "index.html missing from the staged package"
grep -q '<name>' "$STAGE_DIR/config.xml" || die "config.xml has no <name> element (GUI may have written <n>)"

# ------------------------------------------------------------- overrides ---
# Each rewrite must match exactly once, and the result is read back and
# compared with the reference below. A silently unapplied override is the
# failure this guards against: it would upload under the SSSP identity.
say "applying the store's identity from the reference package"
# The rewrite is textual and the readback is a parser, deliberately. An earlier
# version did both with regex and `sed ... | head -1`, which made the check
# tautological: a comment naming these elements was rewritten instead of the
# element, and the readback found the comment and reported success. The two
# steps must not share a blind spot.
python3 -I - "$STAGE_DIR/config.xml" "$REF_DIR/config.xml" <<'PY'
import io, re, sys
import xml.etree.ElementTree as ET

NS = {'tizen': 'http://tizen.org/ns/widgets', 'w': 'http://www.w3.org/ns/widgets'}
path, ref_path = sys.argv[1:3]


def parse(p, what):
    try:
        return ET.parse(p).getroot()
    except ET.ParseError as e:
        raise SystemExit('ERROR: %s is not well-formed XML: %s' % (what, e))


def exactly_one(root, tag, what):
    found = root.findall(tag, NS)
    if len(found) != 1:
        raise SystemExit('ERROR: expected exactly one %s in %s, found %d'
                         % (tag, what, len(found)))
    return found[0]


# The three values the store expects, taken from the package Samsung accepted
# and decoded by the same parser that reads the result back, so the two sides
# cannot disagree about entities or padding.
ref = parse(ref_path, 'the reference config.xml')
appid = exactly_one(ref, 'tizen:application', 'the reference').get('id')
name = (exactly_one(ref, 'w:name', 'the reference').text or '').strip()
profile = exactly_one(ref, 'tizen:profile', 'the reference').get('name')
for label, value in (('Tizen ID', appid), ('<name>', name), ('<tizen:profile>', profile)):
    if not value:
        raise SystemExit('ERROR: the reference config.xml has no %s' % label)

s = io.open(path, encoding='utf-8').read()

# A comment that contains one of these elements would absorb the rewrite. The
# header comment in src/config.xml names all three on purpose, which is exactly
# how someone arrives here; it is safe only because it omits the angle
# brackets, and nothing but this check keeps it that way.
hit = re.search(r'<!--(?:(?!-->).)*?(<tizen:application|<name>|<tizen:profile)', s, re.S)
if hit:
    raise SystemExit(
        "ERROR: a comment in config.xml contains %s. This step rewrites those\n"
        "       elements textually, so it would edit the comment and leave the\n"
        "       real element on the SSSP identity. Name them without angle\n"
        "       brackets in comments." % hit.group(1))

def sub_exactly_once(pattern, repl, text, what):
    # No `count`: counting every match is the point. With count=1, re.subn
    # reports 1 whether the document holds one match or fifty, so a duplicated
    # element would be half-rewritten and pass.
    out, n = re.subn(pattern, repl, text)
    if n != 1:
        raise SystemExit('ERROR: expected exactly one %s in config.xml, found %d' % (what, n))
    return out

s = sub_exactly_once(r'(<tizen:application[^>]*\sid=")[^"]*(")',
                     lambda m: m.group(1) + appid + m.group(2), s, 'Tizen ID')
s = sub_exactly_once(r'<name>[^<]*</name>',
                     lambda m: '<name>' + name + '</name>', s, '<name> element')
s = sub_exactly_once(r'(<tizen:profile[^>]*\sname=")[^"]*(")',
                     lambda m: m.group(1) + profile + m.group(2), s, '<tizen:profile> element')
io.open(path, 'w', encoding='utf-8').write(s)

# Read back with a parser. ElementTree drops comments, so it cannot be fooled
# by the case above, and it rejects a malformed document into the bargain.
root = parse(path, 'config.xml after the rewrite')
got = [
    ('Tizen ID',        exactly_one(root, 'tizen:application', 'the result').get('id'), appid),
    ('<name>',          (exactly_one(root, 'w:name', 'the result').text or '').strip(), name),
    ('<tizen:profile>', exactly_one(root, 'tizen:profile', 'the result').get('name'),   profile),
]
for label, actual, want in got:
    if actual != want:
        raise SystemExit('ERROR: %s is %r after the rewrite but the accepted '
                         'package says %r' % (label, actual, want))
print("  Tizen ID %s, name '%s', profile %s" % (got[0][1], got[1][1], got[2][1]))
PY

# ------------------------------------------------------------- signature ---
say "copying the accepted signature in place of signing"
cp "$REF_DIR/author-signature.xml" "$REF_DIR/signature1.xml" "$STAGE_DIR/"

# ------------------------------------------------------------------- zip ---
# config.xml first: the W3C widget packaging specification asks for it.
say "packaging"
out_abs="$(cd "$OUT_DIR" && pwd)/${out_name}.wgt"
(
    cd "$STAGE_DIR"
    zip -q -X "$out_abs" config.xml
    # -x keeps the entry written above from being stored a second time.
    # -X suppresses the macOS AppleDouble entries.
    zip -q -X -r "$out_abs" . -x config.xml
)

size="$(wc -c < "$out_abs" | tr -d ' ')"
say "built $out_abs ($size bytes)"
echo
say "contents:"
unzip -l "$out_abs" | sed 's/^/      /'
echo
cat <<TXT
Next: Seller Office > Applications > App Package > Upload. The pre-test runs
automatically and reports Pass or Fail with the reason.

Prove the CONTENT on a bench panel first, with the SSSP package built from the
same tree:

    scripts/build-wgt.sh <your-certificate-profile>

This store package will not install that way; its signature describes a
different package.
TXT
