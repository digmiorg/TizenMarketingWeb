#!/usr/bin/env bash
#
# Build and sign the DigmiMarketing widget, and emit the SSSP descriptor beside
# it. Run from the repository root.
#
# Everything a Samsung signage display needs in order to notice and accept a new
# build is decided here, so the rules it enforces are worth stating:
#
#   * The package directory may contain app files only. Tizen signs every file
#     it finds, so whatever the IDE or git left behind is signed as part of the
#     app. Hygiene we control rather than a diagnosed field failure: the 1.0.7
#     package this repository publishes carries .gitignore, .gitattributes and
#     a Build/ directory, and it installed anyway.
#   * `<ver>` in sssp_config.xml must be an INTEGER that increases. The display
#     compares it against the installed build and will not re-download anything
#     unless it grew. Ours used to say "1.0.7", which parses as 1.
#   * `<size>`, when stated, must be the exact byte count of the .wgt — the
#     display checks the download against it and declines a mismatch without
#     saying so. The descriptors currently served to the fleet omit the element
#     entirely; whether that is why production/1.0.9 was never picked up is not
#     established either way. Ours always states it.
#   * `<widgetname>` must equal `<name>` in config.xml.
#
# Usage: scripts/build-wgt.sh <certificate-profile-name>

set -euo pipefail

PROFILE="${1:?usage: build-wgt.sh <certificate-profile-name>}"
TIZEN="${TIZEN_CLI:-tizen}"

SRC_DIR="src"
STAGE_DIR="${BUILD_STAGE_DIR:-.build/package}"
OUT_DIR="${BUILD_OUT_DIR:-.build/out}"

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
    local p rest
    rest=""
    p="${1%/}"
    [ -n "$p" ] || p="/"
    while [ ! -d "$p" ]; do
        rest="${p##*/}${rest:+/}$rest"
        case "$p" in
            */*) p="${p%/*}"; [ -n "$p" ] || p="/" ;;
            *)   p="." ;;
        esac
    done
    # CDPATH= : with a relative argument `cd` searches CDPATH and PRINTS the
    # directory it picked, so without this the command substitution returns TWO
    # lines and the guard validates a different tree from the one `rm -rf`
    # later walks. `--` covers a directory whose name begins with a dash.
    printf '%s\n' "$(CDPATH= cd -P -- "$p" && pwd -P)${rest:+/$rest}"
}

assert_under_build() {
    local label given root abs
    label="$1"
    given="$2"

    # Rejected BEFORE resolution, and this is the load-bearing line. resolve_path
    # resolves the deepest EXISTING ancestor and re-appends the rest verbatim, so
    # a `..` sitting under a component that does not exist yet is never
    # normalised -- it survives into the comparison and still matches. Measured:
    # `.build/a/../../../sibling-repo` was accepted, `mkdir -p` then CREATED
    # `.build/a` so the path became real, and the dotfile sweep deleted `.git`
    # and `.env` in a sibling repository with exit 0 and no warning. That is a
    # worse hole than the string prefix test this guard replaced.
    case "/$given/" in
        *'/../'*) echo "$label must not contain a '..' component; got '$given'" >&2; exit 1 ;;
    esac

    root="$(resolve_path .build)"
    abs="$(resolve_path "$given")"
    case "$abs" in
        "$root"/?*) ;;
        *) echo "$label must resolve to a directory strictly beneath $root; '$given' resolves to '$abs'" >&2; exit 1 ;;
    esac
}

assert_under_build BUILD_STAGE_DIR "$STAGE_DIR"
assert_under_build BUILD_OUT_DIR "$OUT_DIR"

say() { printf '==> %s\n' "$1"; }
die() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- version ---
# config.xml is the single source of truth. main.js carries the same number so
# that a screen can report which build it is running; they drifted once (the
# bundle went to 1.0.30 while the panel still reported 1.0.27), which made
# "did this screen get the fix?" unanswerable. Fail the build instead.

version="$(sed -n 's/.*<widget[^>]* version="\([^"]*\)".*/\1/p' "$SRC_DIR/config.xml" | head -1)"
[ -n "$version" ] || die "could not read version from $SRC_DIR/config.xml"

app_version="$(sed -n "s/.*const appVersion = '\([^']*\)'.*/\1/p" "$SRC_DIR/js/main.js" | head -1)"
[ -n "$app_version" ] || die "could not read appVersion from $SRC_DIR/js/main.js"

if [ "$version" != "$app_version" ]; then
    die "version mismatch: config.xml says $version, main.js appVersion says $app_version"
fi

widget_name="$(sed -n 's/.*<name>\([^<]*\)<\/name>.*/\1/p' "$SRC_DIR/config.xml" | head -1)"
[ -n "$widget_name" ] || die "could not read <name> from $SRC_DIR/config.xml"

# This name becomes a filename, a path, and part of the URL a display fetches,
# so it has to be a plain file name and nothing cleverer. A leading dot would
# also make the package a hidden file, which upload-artifact drops by default
# and nobody would notice until the publish job found no .wgt to copy.
case "$widget_name" in
    *[!A-Za-z0-9._-]* | .* )
        die "<name> is '$widget_name'; it is used as the .wgt filename and in the SSSP URL, so it must be letters, digits, dot, underscore or hyphen, and must not start with a dot" ;;
esac

# An integer that grows with the semantic version. 1.0.10 becomes 10010, which
# also clears the "1" that a legacy "1.0.7" descriptor parses down to, so the
# first CI-built package is seen as an upgrade by screens running the old one.
IFS=. read -r v_major v_minor v_patch <<<"$version"
[ "${v_patch:-}" != "" ] || die "version $version is not major.minor.patch"
[ "$v_minor" -lt 100 ] && [ "$v_patch" -lt 100 ] || die "version $version overflows the <ver> encoding"
sssp_ver=$(( v_major * 10000 + v_minor * 100 + v_patch ))

say "version $version  ->  <ver>$sssp_ver</ver>  (widget: $widget_name)"

# ------------------------------------------------------------------ stage ---
# Copy the app into a clean directory rather than building in place, so the
# repository keeps its .gitignore/.gitattributes and the package does not.

say "staging a clean package directory"
rm -rf "$STAGE_DIR" "$OUT_DIR"
mkdir -p "$STAGE_DIR" "$OUT_DIR"

# Copy everything, then strip what must not be signed. Done this way round on
# purpose: a tar --exclude='.*' pattern also matches the '.' member and
# silently copies nothing, which is a build that succeeds with an empty
# package.
cp -R "$SRC_DIR"/. "$STAGE_DIR"/

# One sweep, at any depth, for everything that must not be signed: dotfiles
# (.gitignore, .gitattributes, .project, .DS_Store …) and Tizen Studio's output
# directories. Previously `Build` was only stripped at the top level while
# dotfiles were stripped everywhere, so a nested js/Build/ survived staging and
# was caught later by verify — a build that fails at the wrong end.
# No `|| true`: a strip that silently fails is a package that silently carries
# metadata.
find "$STAGE_DIR" -mindepth 1 \( -name '.*' -o -name Build -o -name Debug \) \
    -prune -exec rm -rf {} +

# At any depth, not just the top level: the published 1.0.7 package carries a
# nested tizen5.wgt, so a stray package inside the source tree is not
# hypothetical here. A .wgt inside a .wgt is dead weight that gets signed.
find "$STAGE_DIR" -name '*.wgt' -delete

# Tests live beside the code they test, which is the right place for them and
# the wrong place to leave them at packaging time: they are CommonJS, they
# `require()` modules the panel has no loader for, and they would be signed and
# shipped to every screen. Caught by reading the staged file list after
# avplay.test.js appeared in it.
find "$STAGE_DIR" -name '*.test.js' -delete
rm -f "$STAGE_DIR/author-signature.xml" "$STAGE_DIR/signature1.xml"

[ -f "$STAGE_DIR/config.xml" ] || die "config.xml missing from the staged package"
[ -f "$STAGE_DIR/index.html" ] || die "index.html missing from the staged package"

# Tizen Studio's GUI has a habit of rewriting <name> as <n> when tabs are
# switched. A package carrying that renders as a nameless app, so refuse it.
grep -q '<name>' "$STAGE_DIR/config.xml" || die "config.xml has no <name> element (GUI may have written <n>)"

say "staged files:"
(cd "$STAGE_DIR" && find . -type f | sort | sed 's/^/      /')

# ------------------------------------------------------------------ build ---
# Absolute: the CLI resolves a relative path against its own bin directory,
# which is somewhere else entirely.
stage_abs="$(cd "$STAGE_DIR" && pwd)"

say "packaging and signing with profile '$PROFILE'"
"$TIZEN" package -t wgt -s "$PROFILE" -- "$stage_abs"

wgt="$(find "$STAGE_DIR" -maxdepth 1 -name '*.wgt' | head -1 || true)"
[ -n "$wgt" ] || die "tizen package produced no .wgt"

mv "$wgt" "$OUT_DIR/${widget_name}.wgt"
wgt="$OUT_DIR/${widget_name}.wgt"

# ------------------------------------------------------------- descriptor ---
# wc -c rather than stat: the two platforms spell stat differently and this
# number has to be exactly right.
size="$(wc -c < "$wgt" | tr -d ' ')"

cat > "$OUT_DIR/sssp_config.xml" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<widget>
	<ver>${sssp_ver}</ver>
	<size>${size}</size>
	<widgetname>${widget_name}</widgetname>
	<webtype>tizen</webtype>
</widget>
XML

say "built $wgt ($size bytes)"
say "wrote $OUT_DIR/sssp_config.xml"

# Hand the facts to the workflow without it having to re-derive them.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
        echo "version=$version"
        echo "sssp_ver=$sssp_ver"
        echo "size=$size"
        echo "widget_name=$widget_name"
        echo "wgt=$wgt"
    } >> "$GITHUB_OUTPUT"
fi
