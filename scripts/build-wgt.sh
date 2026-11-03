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

# Both are wiped with `rm -rf` below, and both are overridable. Refuse anything
# outside .build/ so that `BUILD_STAGE_DIR=src` cannot delete the source tree.
case "$STAGE_DIR" in .build/*) ;; *) echo "BUILD_STAGE_DIR must live under .build/" >&2; exit 1 ;; esac
case "$OUT_DIR" in .build/*) ;; *) echo "BUILD_OUT_DIR must live under .build/" >&2; exit 1 ;; esac

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

rm -f "$STAGE_DIR"/*.wgt "$STAGE_DIR/author-signature.xml" "$STAGE_DIR/signature1.xml"

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

wgt="$(find "$STAGE_DIR" -maxdepth 1 -name '*.wgt' | head -1)"
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
