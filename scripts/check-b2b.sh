#!/usr/bin/env bash
#
# The gates production/ gets from its two workflows, for the hand-published
# b2b/ channel. For every b2b/<version>/:
#
#   * it carries a descriptor at all (a .wgt without one is invisible to a
#     display, and would otherwise be invisible to this script too);
#   * scripts/verify-wgt.sh passes (descriptor vs package, signatures);
#   * the package is named <widgetname>.wgt, which is the file a display
#     asks for;
#   * the directory name is the package's config.xml version, and <ver> is
#     that version encoded the way scripts/build-wgt.sh encodes it
#     (major*10000 + minor*100 + patch, minor and patch below 100) — this
#     channel is where <ver> is typed by hand, and a wrong one means displays
#     never re-download;
#   * no two version directories advertise the same <ver>;
#   * the package carries the same author key as b2b/latest/ serves (read
#     with scripts/author-identity.sh), or panels on the channel refuse it.
#
# b2b/latest/ must exist and be byte-for-byte one of the version directories.
# It is allowed to be BEHIND the highest <ver>: that is the README's step 1, a
# new version committed alone to be proven on one panel before latest/
# follows. It is reported, not failed. What it may not do is go BACKWARDS:
# with CHECK_B2B_BASE set to a git ref (the workflows set it to the base of
# the pull request), latest/'s <ver> must not be lower than the <ver> that ref
# serves, because a display compares <ver> only and would never download the
# lower one — the silent freeze served-baseline.sh exists to prevent for
# production/.
#
# Exit status: 0 consistent, 1 something is broken, 2 could not check (a
# tool this script needs is missing, the base ref does not resolve, or the
# script itself hit an error it did not plan for) — the publish guard treats
# 2 as its own failure, not as a broken b2b/.
#
# CHECK_B2B_BASE_PATH (default b2b) is where the channel lives in the git
# tree, for when ROOT is somewhere else (the publish guard checks the
# assembled site's copy at _site/b2b).
#
# With CHECK_B2B_FAILED_LIST set to a file path, the directories that failed
# are written there one per line, so the publish guard can drop exactly
# those from the site and keep the rest serving.
#
# Usage: scripts/check-b2b.sh [b2b-dir]   (default: b2b)

set -Eeuo pipefail

ROOT="${1:-b2b}"
BASE_PATH="${CHECK_B2B_BASE_PATH:-b2b}"
here="$(cd "$(dirname "$0")" && pwd)"

# Anything this script did not plan for - a tool failing, a path that is not
# there - is "could not check", never "broken": the publish guard must not
# withhold a correct b2b/ because of a runner fault.
# -E: the trap is inherited into functions too.
trap 'echo "cannot check: unexpected error at line $LINENO"; exit 2' ERR
tmpfiles=''
trap 'rm -f $tmpfiles' EXIT

for tool in unzip openssl python3 sed diff cmp mktemp find basename git; do
    command -v "$tool" >/dev/null 2>&1 || { echo "cannot check: $tool is not installed"; exit 2; }
done

[ -d "$ROOT" ] || { echo "no $ROOT/ directory"; exit 1; }

# The <ver> a descriptor advertises, raw (may be non-numeric).
ver_of() {
    # `|| true`: head closes the pipe, and under pipefail that SIGPIPE would
    # take the script down before it could report what it read.
    sed -n 's|.*<ver>\(.*\)</ver>.*|\1|p' "$1" | head -1 || true
}

# The <widgetname> a descriptor advertises: the file a display asks for.
widgetname_of() {
    sed -n 's|.*<widgetname>\(.*\)</widgetname>.*|\1|p' "$1" | head -1 || true
}

# The version attribute of the <widget> element in a package's config.xml.
package_version() {
    unzip -p "$1" config.xml | sed -n 's|.*<widget [^>]*version="\([0-9.]*\)".*|\1|p' | head -1 || true
}

# Two trees byte-identical? 0 yes, 1 no; anything diff cannot do is "could
# not check" (diff inside an `if` would not reach the ERR trap).
same_tree() {
    local rc=0
    diff -rq "$1" "$2" >/dev/null 2>&1 || rc=$?
    case "$rc" in
        0|1) return "$rc" ;;
        *) echo "cannot check: diff failed ($rc) comparing $1 with $2"; exit 2 ;;
    esac
}

# Two files byte-identical? Same contract as same_tree.
same_file() {
    local rc=0
    cmp -s "$1" "$2" || rc=$?
    case "$rc" in
        0|1) return "$rc" ;;
        *) echo "cannot check: cmp failed ($rc) comparing $1 with $2"; exit 2 ;;
    esac
}

# A semver as the integer <ver> build-wgt.sh derives: major*10000+minor*100+patch.
encode() {
    local major minor patch
    IFS=. read -r major minor patch <<< "$1"
    echo $(( 10#$major * 10000 + 10#$minor * 100 + 10#$patch ))
}

# The signing-key hash of a package, or '' when it cannot be read
# (author-identity.sh says 'none' for that, with exit 0).
key_of() {
    local key
    key="$("$here/author-identity.sh" "$1" 2>/dev/null || true)"
    case "$key" in none) key='' ;; esac
    printf '%s' "$key"
}

fail=0
# Newline-delimited, with a leading newline, so a name with spaces stays one
# entry and "b2b/1.0.1" never matches inside "b2b/1.0.13".
nl='
'
failed_dirs="$nl"
mark_failed() {
    case "$failed_dirs" in
        *"$nl$1$nl"*) ;;
        *) failed_dirs="$failed_dirs$1$nl" ;;
    esac
    fail=1
}
is_failed() {
    case "$failed_dirs" in
        *"$nl$1$nl"*) return 0 ;;
    esac
    return 1
}

highest=''
highest_dir=''
seen_vers=' '
versions=()
# Every directory that is not latest/, failed or not: latest/ mirroring a
# failed one carries the same fault and must be charged too.
candidates=()

for entry in "$ROOT"/*/; do
    [ -d "$entry" ] || continue
    dir="${entry%/}"
    name="$(basename "$dir")"
    echo "== $dir"
    [ "$name" = latest ] || candidates+=("$dir")
    if [ ! -f "$dir/sssp_config.xml" ]; then
        echo "  FAIL  no sssp_config.xml - a display pointed here gets a 404 and keeps its old build"
        mark_failed "$dir"
        continue
    fi
    if ! "$here/verify-wgt.sh" "$dir"; then
        mark_failed "$dir"
        continue
    fi
    [ "$name" = latest ] && continue

    wgts=("$dir"/*.wgt)
    if [ "${#wgts[@]}" -ne 1 ] || [ ! -f "${wgts[0]}" ]; then
        echo "  FAIL  expected exactly one .wgt in $dir, found ${#wgts[@]}"
        mark_failed "$dir"
        continue
    fi
    wgt="${wgts[0]}"
    widget="$(widgetname_of "$dir/sssp_config.xml")"
    if [ "$(basename "$wgt")" != "$widget.wgt" ]; then
        # The display asks for <widgetname>.wgt and nothing else; a package
        # under any other name is a 404 on Pages and a panel that keeps its
        # old build without a word.
        echo "  FAIL  package is $(basename "$wgt") but the descriptor advertises <widgetname>$widget</widgetname>, so a display would fetch $widget.wgt"
        mark_failed "$dir"
        continue
    fi
    pkgver="$(package_version "$wgt")"
    if [ "$pkgver" != "$name" ]; then
        # Not a version directory of this package, whatever else it holds:
        # it does not join the versions, so a stray copy of a good package
        # under a typo'd name is charged alone and never makes the good
        # directory a "duplicate" or latest/ its mirror.
        echo "  FAIL  directory is $name but the package's config.xml says $pkgver"
        mark_failed "$dir"
        continue
    fi
    ver="$(ver_of "$dir/sssp_config.xml")"
    if ! [[ "$ver" =~ ^[0-9]+$ ]]; then
        echo "  FAIL  <ver>$ver</ver> is not an integer"
        mark_failed "$dir"
        continue
    fi
    # Same contract as build-wgt.sh: three numeric parts, minor and patch
    # below 100, or the encoding is ambiguous (1.0.100 and 1.1.0 would both
    # be 10100). Anything else is refused here, not silently skipped.
    if ! [[ "$pkgver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "  FAIL  package version '$pkgver' is not major.minor.patch, so <ver> cannot be derived from it"
        mark_failed "$dir"
        continue
    fi
    IFS=. read -r _ pminor ppatch <<< "$pkgver"
    if [ "$((10#$pminor))" -ge 100 ] || [ "$((10#$ppatch))" -ge 100 ]; then
        echo "  FAIL  package version $pkgver has a minor or patch of 100 or more, which collides in the <ver> encoding"
        mark_failed "$dir"
        continue
    fi
    expected="$(encode "$pkgver")"
    if [ "$ver" != "$expected" ]; then
        # A wrong <ver> must not reach seen_vers or highest: the directory
        # that legitimately owns that number would be charged as a duplicate.
        echo "  FAIL  <ver>$ver</ver> is not $pkgver encoded ($expected)"
        mark_failed "$dir"
        continue
    fi
    case "$seen_vers" in
        *" $ver "*) echo "  FAIL  <ver>$ver</ver> is advertised by more than one version directory"; mark_failed "$dir"; continue ;;
    esac
    seen_vers="$seen_vers$ver "
    versions+=("$dir")
    if [ -z "$highest" ] || [ "$ver" -gt "$highest" ]; then
        highest="$ver"
        highest_dir="$dir"
    fi
done

# ---- what the base serves, if a base was given -------------------------------
base_ver=''
base_key=''
base_wgt_tmp=''
base_has_latest=0
if [ -n "${CHECK_B2B_BASE:-}" ]; then
    # A base that does not resolve is "could not check", never "nothing to go
    # backwards from" - otherwise a wrong ref in the workflow would turn these
    # rules off on every pull request without anyone seeing it.
    git rev-parse --verify -q "$CHECK_B2B_BASE^{commit}" >/dev/null 2>&1 \
        || { echo "cannot check: base $CHECK_B2B_BASE does not resolve to a commit"; exit 2; }
    base_cfg="$(git cat-file blob "$CHECK_B2B_BASE:$BASE_PATH/latest/sssp_config.xml" 2>/dev/null || true)"
    if [ -n "$base_cfg" ]; then
        base_has_latest=1
        base_ver="$(printf '%s\n' "$base_cfg" | sed -n 's|.*<ver>\(.*\)</ver>.*|\1|p' | head -1 || true)"
        base_wgt="$(printf '%s\n' "$base_cfg" | sed -n 's|.*<widgetname>\(.*\)</widgetname>.*|\1|p' | head -1 || true).wgt"
        base_wgt_tmp="$(mktemp)"
        tmpfiles="$tmpfiles $base_wgt_tmp"
        # cat-file blob: plumbing, so no textconv or filter can ever rewrite
        # the bytes on the way out.
        if git cat-file blob "$CHECK_B2B_BASE:$BASE_PATH/latest/$base_wgt" > "$base_wgt_tmp" 2>/dev/null; then
            base_key="$(key_of "$base_wgt_tmp")"
        else
            echo "cannot check: $CHECK_B2B_BASE has a $BASE_PATH/latest descriptor but no $base_wgt beside it"
            exit 2
        fi
    elif [ "$ROOT" != "$BASE_PATH" ] && ! git cat-file -e "$CHECK_B2B_BASE:$BASE_PATH" 2>/dev/null; then
        # ROOT points somewhere else (a scratch copy, the assembled site) and
        # the base has no such tree at all: that is a wrong CHECK_B2B_BASE_PATH,
        # not a channel that does not exist yet.
        echo "cannot check: $CHECK_B2B_BASE has no $BASE_PATH/ - set CHECK_B2B_BASE_PATH to where the channel lives in the tree"
        exit 2
    fi
fi

# ---- latest/ ------------------------------------------------------------------
echo "== $ROOT/latest against the version directories"
latest_ok=0
if [ ! -d "$ROOT/latest" ]; then
    # Every panel on the channel follows latest/; without it they 404 on
    # the descriptor, and no version is compared with any other.
    echo "  FAIL  $ROOT/latest is missing"
    fail=1
elif is_failed "$ROOT/latest"; then
    echo "  skip  $ROOT/latest already failed above"
else
    # A good version directory it mirrors is what counts; a stray copy of
    # the same bytes under a bad name does not take latest/ down with it.
    match=''
    for dir in ${versions[@]+"${versions[@]}"}; do
        if same_tree "$ROOT/latest" "$dir"; then
            match="$dir"
            break
        fi
    done
    # No good one: byte-identical to a directory that failed means it
    # carries the same fault, and it is the directory every panel follows.
    # Checked before "no version directory" so a mirrored fault is never
    # hidden behind that.
    mirrored_fault=''
    if [ -z "$match" ]; then
        for dir in ${candidates[@]+"${candidates[@]}"}; do
            if is_failed "$dir" && same_tree "$ROOT/latest" "$dir"; then
                mirrored_fault="$dir"
                break
            fi
        done
    fi
    if [ -n "$mirrored_fault" ]; then
        echo "  FAIL  $ROOT/latest is identical to $mirrored_fault, which failed above"
        mark_failed "$ROOT/latest"
    elif [ "${#versions[@]}" -eq 0 ]; then
        echo "  FAIL  no version directory to compare $ROOT/latest with"
        fail=1
    elif [ -z "$match" ]; then
        echo "  FAIL  $ROOT/latest is not identical to any version directory"
        mark_failed "$ROOT/latest"
    elif [ "$match" = "$highest_dir" ]; then
        echo "  ok    identical to $match, the highest <ver> ($highest)"
        latest_ok=1
    else
        echo "  note  identical to $match; $highest_dir (<ver>$highest</ver>) is not on latest/ yet (README step 1 - prove it on a panel first)"
        [ -n "${GITHUB_ACTIONS:-}" ] && echo "::notice::$ROOT/latest serves $match, not $highest_dir"
        latest_ok=1
    fi
fi

# ---- author key: one reference, every directory against it -------------------
# The key the fleet runs is the one the base's latest/ carries; without a base
# it is whatever latest/ carries now. Every directory, latest/ included, is
# compared with that one key, and whichever differs is the one charged.
ref_key=''
ref_src=''
if [ -n "$base_key" ]; then
    ref_key="$base_key"; ref_src="$CHECK_B2B_BASE's $BASE_PATH/latest"
elif [ "$base_has_latest" -eq 1 ]; then
    # The problem is in the base, not in this change: could not check.
    echo "cannot check: could not read the author key $CHECK_B2B_BASE's $BASE_PATH/latest serves"
    exit 2
elif [ "$latest_ok" -eq 1 ]; then
    lw=("$ROOT/latest"/*.wgt)
    ref_key="$(key_of "${lw[0]}")"
    ref_src="$ROOT/latest"
    if [ -z "$ref_key" ]; then
        echo "  FAIL  could not read the author key of $ROOT/latest"
        mark_failed "$ROOT/latest"
    fi
fi
if [ -n "$ref_key" ]; then
    echo "== author key: every directory must carry $ref_key ($ref_src)"
    to_check=(${versions[@]+"${versions[@]}"})
    [ "$latest_ok" -eq 1 ] && to_check+=("$ROOT/latest")
    key_fails=0
    for dir in ${to_check[@]+"${to_check[@]}"}; do
        is_failed "$dir" && continue
        dw=("$dir"/*.wgt)
        key="$(key_of "${dw[0]}")"
        if [ -z "$key" ]; then
            echo "  FAIL  could not read the author key of $dir"
            mark_failed "$dir"
            key_fails=$((key_fails + 1))
        elif [ "$key" != "$ref_key" ]; then
            echo "  FAIL  $dir is signed with author key $key, not $ref_key - panels on the channel would refuse it"
            mark_failed "$dir"
            key_fails=$((key_fails + 1))
        fi
    done
    [ "$key_fails" -eq 0 ] && echo "  ok    every directory carries it"
fi

# ---- against the base: never backwards, never a new package under an old <ver>
if [ "$base_has_latest" -eq 1 ] && [ "$latest_ok" -eq 1 ]; then
    echo "== $ROOT/latest against $CHECK_B2B_BASE"
    new_ver="$(ver_of "$ROOT/latest/sssp_config.xml")"
    if [[ "$base_ver" =~ ^[0-9]+$ ]] && [[ "$new_ver" =~ ^[0-9]+$ ]] && [ "$new_ver" -lt "$base_ver" ]; then
        echo "  FAIL  $ROOT/latest goes from <ver>$base_ver</ver> to <ver>$new_ver</ver> - displays never download a lower <ver>, so this is a silent freeze, not a rollback"
        mark_failed "$ROOT/latest"
    elif [ "$new_ver" = "$base_ver" ]; then
        lw=("$ROOT/latest"/*.wgt)
        if same_file "${lw[0]}" "$base_wgt_tmp"; then
            echo "  ok    <ver>$new_ver</ver> and the package are unchanged"
        else
            echo "  FAIL  the package in $ROOT/latest changed but <ver>$new_ver</ver> did not - no display would ever download it (a re-sign needs a version bump)"
            mark_failed "$ROOT/latest"
        fi
    else
        echo "  ok    <ver>$new_ver</ver> is above $CHECK_B2B_BASE's <ver>$base_ver</ver>"
    fi
fi
if [ -n "${CHECK_B2B_BASE:-}" ]; then
    # A version directory the base already serves must be the same bytes:
    # its <ver> is fixed by its name, so a changed package there is the same
    # silent no-op.
    for dir in ${versions[@]+"${versions[@]}"}; do
        is_failed "$dir" && continue
        name="$(basename "$dir")"
        dw=("$dir"/*.wgt)
        if git cat-file -e "$CHECK_B2B_BASE:$BASE_PATH/$name/$(basename "${dw[0]}")" 2>/dev/null; then
            vt="$(mktemp)"
            tmpfiles="$tmpfiles $vt"
            git cat-file blob "$CHECK_B2B_BASE:$BASE_PATH/$name/$(basename "${dw[0]}")" > "$vt"
            if ! same_file "${dw[0]}" "$vt"; then
                echo "  FAIL  $dir is already served by $CHECK_B2B_BASE with other bytes - a published version is immutable, publish a new one instead"
                mark_failed "$dir"
            fi
        fi
    done
fi

if [ -n "${CHECK_B2B_FAILED_LIST:-}" ]; then
    printf '%s' "${failed_dirs#"$nl"}" > "$CHECK_B2B_FAILED_LIST"
fi

[ "$fail" -eq 0 ] && echo "$ROOT/ looks consistent"
exit "$fail"
