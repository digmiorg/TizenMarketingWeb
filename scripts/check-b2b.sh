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
    sed -n 's|.*<ver>\(.*\)</ver>.*|\1|p' "$1/sssp_config.xml" | head -1
}

# The version attribute of the <widget> element in a package's config.xml.
package_version() {
    unzip -p "$1" config.xml | sed -n 's|.*<widget [^>]*version="\([0-9.]*\)".*|\1|p' | head -1
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
            wgts=("$dir"/*.wgt)
            # stdout passes through: a renewal over the same key is a
            # ::warning:: the gate prints, and it belongs in the CI summary.
            rc=0
            "$here/author-identity-gate.sh" "${wgts[0]}" "$ROOT/latest" | sed 's/^/        /' || rc="${PIPESTATUS[0]}"
            case "$rc" in
                0) echo "  ok    $dir carries the author key $ROOT/latest serves" ;;
                2) echo "  FAIL  $dir is signed with a different author key than $ROOT/latest - panels on the channel would refuse it"; fail=1 ;;
                *) echo "  FAIL  author-identity-gate.sh could not compare $dir with $ROOT/latest (exit $rc)"; fail=1 ;;
            esac
        done
    fi
fi

[ "$fail" -eq 0 ] && echo "$ROOT/ looks consistent"
exit "$fail"
