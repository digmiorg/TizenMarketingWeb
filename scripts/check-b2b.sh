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
#   * the package carries the same author key as b2b/latest/ serves
#     (scripts/author-identity-gate.sh), or panels on the channel refuse it.
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
# tool this script needs is missing) — the publish guard treats 2 as its own
# failure, not as a broken b2b/.
#
# With CHECK_B2B_FAILED_LIST set to a file path, the directories that failed
# are written there one per line, so the publish guard can drop exactly
# those from the site and keep the rest serving.
#
# Usage: scripts/check-b2b.sh [b2b-dir]   (default: b2b)

set -euo pipefail

ROOT="${1:-b2b}"
here="$(cd "$(dirname "$0")" && pwd)"

for tool in unzip openssl python3 sed; do
    command -v "$tool" >/dev/null 2>&1 || { echo "cannot check: $tool is not installed"; exit 2; }
done

[ -d "$ROOT" ] || { echo "no $ROOT/ directory"; exit 1; }

# The <ver> a directory's descriptor advertises, raw (may be non-numeric).
ver_of() {
    # `|| true`: head closes the pipe, and under pipefail that SIGPIPE would
    # take the script down before it could report what it read.
    sed -n 's|.*<ver>\(.*\)</ver>.*|\1|p' "$1" | head -1 || true
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
failed_dirs=''
mark_failed() {
    case " $failed_dirs " in
        *" $1 "*) ;;
        *) failed_dirs="$failed_dirs $1" ;;
    esac
    fail=1
}

# Take a directory back out of the failed list (fail itself stays set).
unmark_failed() {
    failed_dirs=" $failed_dirs "
    failed_dirs="${failed_dirs// $1 / }"
    failed_dirs="${failed_dirs# }"
    failed_dirs="${failed_dirs% }"
}

highest=''
highest_dir=''
seen_vers=' '
versions=()

for entry in "$ROOT"/*/; do
    [ -d "$entry" ] || continue
    dir="${entry%/}"
    name="$(basename "$dir")"
    echo "== $dir"
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
    widget="$(widgetname_of "$dir")"
    if [ "$(basename "$wgt")" != "$widget.wgt" ]; then
        # The display asks for <widgetname>.wgt and nothing else; a package
        # under any other name is a 404 on Pages and a panel that keeps its
        # old build without a word.
        echo "  FAIL  package is $(basename "$wgt") but the descriptor advertises <widgetname>$widget</widgetname>, so a display would fetch $widget.wgt"
        mark_failed "$dir"
    fi
    pkgver="$(package_version "$wgt")"
    if [ "$pkgver" != "$name" ]; then
        echo "  FAIL  directory is $name but the package's config.xml says $pkgver"
        mark_failed "$dir"
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
    if [ "$ver" != "$(encode "$pkgver")" ]; then
        echo "  FAIL  <ver>$ver</ver> is not $pkgver encoded ($(encode "$pkgver"))"
        mark_failed "$dir"
    fi
    case "$seen_vers" in
        *" $ver "*) echo "  FAIL  <ver>$ver</ver> is advertised by more than one version directory"; mark_failed "$dir" ;;
    esac
    seen_vers="$seen_vers$ver "
    versions+=("$dir")
    if [ -z "$highest" ] || [ "$ver" -gt "$highest" ]; then
        highest="$ver"
        highest_dir="$dir"
    fi
done

echo "== $ROOT/latest"
if [ ! -d "$ROOT/latest" ]; then
    # Every panel on the channel follows latest/; without it they 404 on
    # the descriptor, and no version is compared with any other.
    echo "  FAIL  $ROOT/latest is missing"
    fail=1
elif [ "${#versions[@]}" -eq 0 ]; then
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
        mark_failed "$ROOT/latest"
    elif [ "$match" = "$highest_dir" ]; then
        echo "  ok    identical to $match, the highest <ver> ($highest)"
    else
        echo "  note  identical to $match; $highest_dir (<ver>$highest</ver>) is not on latest/ yet (README step 1 - prove it on a panel first)"
        [ -n "${GITHUB_ACTIONS:-}" ] && echo "::notice::$ROOT/latest serves $match, not $highest_dir"
    fi

    latest_key=''
    key_charged=''
    latest_wgts=("$ROOT/latest"/*.wgt)
    if [ "${#latest_wgts[@]}" -ne 1 ] || [ ! -f "${latest_wgts[0]}" ]; then
        echo "  FAIL  expected exactly one .wgt in $ROOT/latest, found ${#latest_wgts[@]}"
        mark_failed "$ROOT/latest"
    else
        # Per directory, so that exactly the directory with the other key is
        # charged - latest/ is the fleet's path and keeps serving, and a good
        # version beside a bad one keeps serving too. author-identity.sh
        # prints the package's signing-key hash (what a display binds on).
        # author-identity.sh prints 'none' (exit 0) for a package whose
        # author signature it cannot read, so that word is "unreadable" here,
        # never a key to compare with.
        latest_key="$("$here/author-identity.sh" "${latest_wgts[0]}" 2>/dev/null || true)"
        case " $failed_dirs " in
            *" $ROOT/latest "*)
                echo "  skip  $ROOT/latest already failed above - not charging version directories against its key" ;;
            *)
                case "$latest_key" in
                    ''|none)
                        echo "  FAIL  could not read the author key of $ROOT/latest"
                        mark_failed "$ROOT/latest" ;;
                    *)
                        differing=0
                        version_keys=''
                        # What had already failed before the key comparison:
                        # those directories are never given back below.
                        failed_before_keys="$failed_dirs"
                        for dir in "${versions[@]}"; do
                            vwgts=("$dir"/*.wgt)
                            key="$("$here/author-identity.sh" "${vwgts[0]}" 2>/dev/null || true)"
                            version_keys="$version_keys$dir=$key "
                            case "$key" in
                                ''|none)
                                    echo "  FAIL  could not read the author key of $dir"
                                    mark_failed "$dir"; continue ;;
                            esac
                            if [ "$key" = "$latest_key" ]; then
                                continue
                            fi
                            echo "  FAIL  $dir is signed with author key $key but $ROOT/latest serves $latest_key - panels on the channel would refuse it"
                            mark_failed "$dir"
                            key_charged="$key_charged$dir "
                            differing=$((differing + 1))
                        done
                        [ "$differing" -eq 0 ] && echo "  ok    every version carries the author key $ROOT/latest serves ($latest_key)" ;;
                esac ;;
        esac
    fi

    # latest/ must never advertise a lower <ver> than it did before: a
    # display compares <ver> only and would stay on the higher one, with no
    # error anywhere.
    if [ -n "${CHECK_B2B_BASE:-}" ]; then
        # A base that does not resolve is "could not check", never "nothing
        # to go backwards from" - otherwise a wrong ref in the workflow would
        # turn this rule off on every pull request without anyone seeing it.
        git rev-parse --verify -q "$CHECK_B2B_BASE^{commit}" >/dev/null 2>&1 \
            || { echo "cannot check: base $CHECK_B2B_BASE does not resolve to a commit"; exit 2; }
        base_cfg="$(git show "$CHECK_B2B_BASE:$ROOT/latest/sssp_config.xml" 2>/dev/null || true)"
        if [ -n "$base_cfg" ]; then
            # latest/ may not change author key either: the versions are
            # compared against latest/ above, so a latest/ that swapped key
            # together with a matching new version would otherwise pass and
            # charge the OLD, good directories. The base's latest/ is the
            # key the fleet actually runs.
            base_wgt="$(printf '%s\n' "$base_cfg" | sed -n 's|.*<widgetname>\(.*\)</widgetname>.*|\1|p' | head -1 || true).wgt"
            base_tmp="$(mktemp)"
            case " $failed_dirs " in
                *" $ROOT/latest "*)
                    echo "  skip  $ROOT/latest already failed above - not comparing its author key with $CHECK_B2B_BASE" ;;
                *)
            # cat-file blob: plumbing, so no textconv or filter can ever
            # rewrite the bytes on the way out.
            if git cat-file blob "$CHECK_B2B_BASE:$ROOT/latest/$base_wgt" > "$base_tmp" 2>/dev/null; then
                base_key="$("$here/author-identity.sh" "$base_tmp" 2>/dev/null || true)"
                case "$base_key" in
                    ''|none) echo "  FAIL  could not read the author key $CHECK_B2B_BASE's $ROOT/latest serves"; mark_failed "$ROOT/latest" ;;
                    "$latest_key") echo "  ok    $ROOT/latest keeps the author key $CHECK_B2B_BASE serves" ;;
                    *)
                        echo "  FAIL  $ROOT/latest changes author key from $base_key ($CHECK_B2B_BASE) to ${latest_key:-?} - every panel on the channel would refuse it"
                        mark_failed "$ROOT/latest"
                        # The version directories charged ONLY for differing
                        # from a latest/ that is itself the fault, and that
                        # still carry the base's key, are the good ones.
                        # Give exactly those back.
                        set -f
                        for pair in ${version_keys:-}; do
                            vdir="${pair%=*}"
                            vkey="${pair##*=}"
                            case " $key_charged " in
                                *" $vdir "*) ;;
                                *) continue ;;
                            esac
                            case " ${failed_before_keys:-} " in
                                *" $vdir "*) continue ;;
                            esac
                            if [ "$vkey" = "$base_key" ]; then
                                unmark_failed "$vdir"
                                echo "  ok    $vdir carries the base's key - not withheld"
                            fi
                        done
                        set +f ;;
                esac
            else
                echo "  FAIL  $CHECK_B2B_BASE has a $ROOT/latest descriptor but no $base_wgt beside it"
                mark_failed "$ROOT/latest"
            fi ;;
            esac
            rm -f "$base_tmp"
            base_ver="$(printf '%s\n' "$base_cfg" | sed -n 's|.*<ver>\(.*\)</ver>.*|\1|p' | head -1 || true)"
            new_ver="$(ver_of "$ROOT/latest/sssp_config.xml")"
            if [[ "$base_ver" =~ ^[0-9]+$ ]] && [[ "$new_ver" =~ ^[0-9]+$ ]] && [ "$new_ver" -lt "$base_ver" ]; then
                echo "  FAIL  $ROOT/latest goes from <ver>$base_ver</ver> ($CHECK_B2B_BASE) to <ver>$new_ver</ver> - displays never download a lower <ver>, so this is a silent freeze, not a rollback"
                mark_failed "$ROOT/latest"
            else
                echo "  ok    <ver>$new_ver</ver> is not below $CHECK_B2B_BASE's <ver>${base_ver:-none}</ver>"
            fi
        else
            echo "  ok    $CHECK_B2B_BASE serves no $ROOT/latest yet - nothing to go backwards from"
        fi
    fi
fi

if [ -n "${CHECK_B2B_FAILED_LIST:-}" ]; then
    # Word splitting is the point; pathname expansion is not.
    set -f
    printf '%s\n' $failed_dirs > "$CHECK_B2B_FAILED_LIST"
    set +f
fi

[ "$fail" -eq 0 ] && echo "$ROOT/ looks consistent"
exit "$fail"
