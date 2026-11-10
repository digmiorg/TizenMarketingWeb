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

ver_of() {
    sed -n 's|.*<ver>\(.*\)</ver>.*|\1|p' "$1/sssp_config.xml" | head -1
}

package_version() {
    unzip -p "$1" config.xml | sed -n 's|.*<widget [^>]*version="\([0-9.]*\)".*|\1|p' | head -1
}

encode() {
    local major minor patch
    IFS=. read -r major minor patch <<< "$1"
    echo $(( 10#$major * 10000 + 10#$minor * 100 + 10#$patch ))
}

fail=0
highest=''
highest_dir=''
declare -A seen_ver=()
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

    wgt="$(find "$dir" -maxdepth 1 -name '*.wgt' | head -1)"
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
    if [[ "$pkgver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ "$ver" != "$(encode "$pkgver")" ]; then
        echo "  FAIL  <ver>$ver</ver> is not $pkgver encoded ($(encode "$pkgver"))"
        fail=1
    fi
    if [ -n "${seen_ver[$ver]:-}" ]; then
        echo "  FAIL  <ver>$ver</ver> is also advertised by ${seen_ver[$ver]}"
        fail=1
    fi
    seen_ver[$ver]="$dir"
    versions+=("$dir")
    if [ -z "$highest" ] || [ "$ver" -gt "$highest" ]; then
        highest="$ver"
        highest_dir="$dir"
    fi
done

if [ -d "$ROOT/latest" ]; then
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
        for dir in "${versions[@]}"; do
            wgt="$(find "$dir" -maxdepth 1 -name '*.wgt' | head -1)"
            if "$here/author-identity-gate.sh" "$wgt" "$ROOT/latest" >/dev/null 2>&1; then
                echo "  ok    $dir carries the author key $ROOT/latest serves"
            else
                echo "  FAIL  $dir is signed with a different author key than $ROOT/latest - panels on the channel would refuse it (author-identity-gate.sh exit $?)"
                fail=1
            fi
        done
    fi
fi

[ "$fail" -eq 0 ] && echo "$ROOT/ looks consistent"
exit "$fail"
