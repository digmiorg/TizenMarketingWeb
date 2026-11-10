#!/usr/bin/env bash
#
# The gates production/ gets from its two workflows, for the hand-published
# b2b/ channel. For every b2b/<version>/ that carries a descriptor:
#
#   * scripts/verify-wgt.sh passes (descriptor vs package, signatures);
#   * the directory name is the package's config.xml version, and <ver> is
#     that version encoded the way scripts/build-wgt.sh encodes it
#     (major*10000 + minor*100 + patch) — this channel is where <ver> is
#     typed by hand, and a wrong one means displays never re-download;
#   * no two version directories advertise the same <ver>;
#   * the package carries the same author key as b2b/latest/ serves
#     (scripts/author-identity-gate.sh), or panels on the channel refuse it.
#
# b2b/latest/ must be byte-for-byte one of the version directories. It is
# allowed to be BEHIND the highest <ver>: that is the README's step 1, a new
# version committed alone to be proven on one panel before latest/ follows.
# It is reported, not failed. Run by the Verify b2b workflow and by hand.
#
# Usage: scripts/check-b2b.sh [b2b-dir]   (default: b2b)

set -euo pipefail

ROOT="${1:-b2b}"
here="$(cd "$(dirname "$0")" && pwd)"

[ -d "$ROOT" ] || { echo "no $ROOT/ directory"; exit 1; }

# The <ver> a directory's descriptor advertises, raw (may be non-numeric).
ver_of() {
    # `|| true`: head closes the pipe, and under pipefail that SIGPIPE would
    # take the script down before it could report what it read.
    sed -n 's|.*<ver>\(.*\)</ver>.*|\1|p' "$1/sssp_config.xml" | head -1 || true
}

# The <widgetname> a directory's descriptor advertises: the file a display asks for.
widgetname_of() {
    sed -n 's|.*<widgetname>\(.*\)</widgetname>.*|\1|p' "$1/sssp_config.xml" | head -1 || true
}

# The version attribute of the <widget> element in a package's config.xml.
package_version() {
    unzip -p "$1" config.xml | sed -n 's|.*<widget [^>]*version="\([0-9.]*\)".*|\1|p' | head -1 || true
}

# A semver as the integer <ver> build-wgt.sh derives: major*10000+minor*100+patch.
encode() {
    local major minor patch
    IFS=. read -r major minor patch <<< "$1"
    echo $(( 10#$major * 10000 + 10#$minor * 100 + 10#$patch ))
}

fail=0
highest=''
highest_dir=''
seen_vers=' '
versions=()

for cfg in "$ROOT"/*/sssp_config.xml; do
    [ -f "$cfg" ] || continue
    dir="${cfg%/sssp_config.xml}"
    name="$(basename "$dir")"
    echo "== $dir"
    if ! "$here/verify-wgt.sh" "$dir"; then
        fail=1
        continue
    fi
    [ "$name" = latest ] && continue

    wgts=("$dir"/*.wgt)
    if [ "${#wgts[@]}" -ne 1 ] || [ ! -f "${wgts[0]}" ]; then
        echo "  FAIL  expected exactly one .wgt in $dir, found ${#wgts[@]}"
        fail=1
        continue
    fi
    wgt="${wgts[0]}"
    widget="$(widgetname_of "$dir")"
    if [ "$(basename "$wgt")" != "$widget.wgt" ]; then
        # The display asks for <widgetname>.wgt and nothing else; a package
        # under any other name is a 404 on Pages and a panel that keeps its
        # old build without a word.
        echo "  FAIL  package is $(basename "$wgt") but the descriptor advertises <widgetname>$widget</widgetname>, so a display would fetch $widget.wgt"
        fail=1
    fi
    pkgver="$(package_version "$wgt")"
    if [ "$pkgver" != "$name" ]; then
        echo "  FAIL  directory is $name but the package's config.xml says $pkgver"
        fail=1
    fi
    ver="$(ver_of "$dir")"
    if ! [[ "$ver" =~ ^[0-9]+$ ]]; then
        echo "  FAIL  <ver>$ver</ver> is not an integer"
        fail=1
        continue
    fi
    # Same contract as build-wgt.sh: three numeric parts, minor and patch
    # below 100, or the encoding is ambiguous (1.0.100 and 1.1.0 would both
    # be 10100). Anything else is refused here, not silently skipped.
    if ! [[ "$pkgver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "  FAIL  package version '$pkgver' is not major.minor.patch, so <ver> cannot be derived from it"
        fail=1
        continue
    fi
    IFS=. read -r _ pminor ppatch <<< "$pkgver"
    if [ "$((10#$pminor))" -ge 100 ] || [ "$((10#$ppatch))" -ge 100 ]; then
        echo "  FAIL  package version $pkgver has a minor or patch of 100 or more, which collides in the <ver> encoding"
        fail=1
        continue
    fi
    if [ "$ver" != "$(encode "$pkgver")" ]; then
        echo "  FAIL  <ver>$ver</ver> is not $pkgver encoded ($(encode "$pkgver"))"
        fail=1
    fi
    case "$seen_vers" in
        *" $ver "*) echo "  FAIL  <ver>$ver</ver> is advertised by more than one version directory"; fail=1 ;;
    esac
    seen_vers="$seen_vers$ver "
    versions+=("$dir")
    if [ -z "$highest" ] || [ "$ver" -gt "$highest" ]; then
        highest="$ver"
        highest_dir="$dir"
    fi
done

if [ ! -d "$ROOT/latest" ]; then
    # Every panel on the channel follows latest/; without it they 404 on
    # the descriptor, and no version is compared with any other.
    echo "== $ROOT/latest"
    echo "  FAIL  $ROOT/latest is missing"
    fail=1
else
    echo "== $ROOT/latest"
    if [ "${#versions[@]}" -eq 0 ]; then
        echo "  FAIL  no version directory to compare $ROOT/latest with"
        fail=1
    else
        match=''
        for dir in "${versions[@]}"; do
            if diff -rq "$ROOT/latest" "$dir" >/dev/null 2>&1; then
                match="$dir"
                break
            fi
        done
        if [ -z "$match" ]; then
            echo "  FAIL  $ROOT/latest is not identical to any version directory"
            fail=1
        elif [ "$match" = "$highest_dir" ]; then
            echo "  ok    identical to $match, the highest <ver> ($highest)"
        else
            echo "  note  identical to $match; $highest_dir (<ver>$highest</ver>) is not on latest/ yet (README step 1 - prove it on a panel first)"
            [ -n "${GITHUB_ACTIONS:-}" ] && echo "::notice::$ROOT/latest serves $match, not $highest_dir"
        fi
        # One gate call: latest/'s package is the candidate, every version
        # directory is a served directory, and the gate prints each one's
        # key. stdout passes through: a renewal over the same key is a
        # ::warning:: the gate prints, and it belongs in the CI summary.
        latest_wgts=("$ROOT/latest"/*.wgt)
        rc=0
        "$here/author-identity-gate.sh" "${latest_wgts[0]}" "${versions[@]}" | sed 's/^/        /' || rc="${PIPESTATUS[0]}"
        case "$rc" in
            0) echo "  ok    every version carries the author key $ROOT/latest serves" ;;
            2) echo "  FAIL  a version directory is signed with a different author key than $ROOT/latest - panels on the channel would refuse it (see the keys above)"; fail=1 ;;
            *) echo "  FAIL  author-identity-gate.sh could not compare the versions with $ROOT/latest (exit $rc)"; fail=1 ;;
        esac
    fi
fi

[ "$fail" -eq 0 ] && echo "$ROOT/ looks consistent"
exit "$fail"
