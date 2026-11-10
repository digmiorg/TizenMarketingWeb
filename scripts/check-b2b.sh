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
# A deliberate change of author key - the channel moving to a new key, which
# means every panel on it has to be emptied and re-pointed - is sanctioned by
# committing the new key's sha256 to .github/b2b-accept-key (or passing it as
# CHECK_B2B_ACCEPT_KEY). That file is in the pull request's diff, so the
# rotation is reviewed where it happens instead of by merging a red check.
# While the file's first line names latest/'s key, that key is the reference
# and the directories still on ONE older key are kept (for panels not yet
# re-pointed): in pull-request mode those the base already serves; without a
# base - the publish guard - only directories on the key the file's SECOND
# line names, the key being replaced, so a stale file never admits a package
# on some third key. A directory the base serves
# may be removed once its key is no longer the key the base's latest/
# carries. Removing the file ends the rotation; remove the old directories
# in the same pull request, or they fail from then on.
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

for tool in unzip openssl python3 sed cmp mktemp find basename git; do
    command -v "$tool" >/dev/null 2>&1 || { echo "cannot check: $tool is not installed"; exit 2; }
done

# No channel is not a broken channel: a tree without b2b/ has nothing to
# check, and the guard treats it the same way.
[ -d "$ROOT" ] || { echo "no $ROOT/ - nothing to check"; exit 0; }

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

# Two files byte-identical? 0 yes, 1 no; anything cmp cannot do is "could not
# check" (cmp inside an `if` would not reach the ERR trap).
same_file() {
    local rc=0
    cmp -s "$1" "$2" || rc=$?
    case "$rc" in
        0|1) return "$rc" ;;
        *) echo "cannot check: cmp failed ($rc) comparing $1 with $2"; exit 2 ;;
    esac
}

# A directory of this channel holds exactly two entries: the descriptor and
# <widgetname>.wgt. Anything else (a stray file, a dotfile, a nested dir) is
# a fault of THAT directory - a display never asks for it, and it must not
# make latest/ "not identical" to a good package.
extra_entries() {
    local d="$1" widget="$2" n
    for n in "$d"/* "$d"/.[!.]* "$d"/..?*; do
        [ -e "$n" ] || [ -L "$n" ] || continue
        case "$(basename "$n")" in
            sssp_config.xml|"$widget.wgt") ;;
            *) printf '%s ' "$(basename "$n")" ;;
        esac
    done
}

# Do two directories serve the same package - same descriptor, same
# <widgetname>.wgt? Stray entries beside them do not count here; they are
# a fault of the directory that carries them, not of the package.
same_pkg() {
    local a="$1" b="$2" wa wb
    wa="$(widgetname_of "$a/sssp_config.xml")"; wb="$(widgetname_of "$b/sssp_config.xml")"
    [ "$wa" = "$wb" ] || return 1
    [ -f "$a/$wa.wgt" ] && [ -f "$b/$wb.wgt" ] || return 1
    same_file "$a/sssp_config.xml" "$b/sssp_config.xml" || return 1
    same_file "$a/$wa.wgt" "$b/$wb.wgt"
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

# Nothing but directories belongs directly under the channel root: a stray
# file or package there is published world-readable, unversioned and
# unchecked.
for n in "$ROOT"/* "$ROOT"/.[!.]* "$ROOT"/..?*; do
    [ -e "$n" ] || [ -L "$n" ] || continue
    # ${n##*/}, not $(basename): a command substitution strips a trailing
    # newline, which is exactly the character this must see.
    bn="${n##*/}"
    case "$n" in
        *[[:cntrl:]]*)
            # A name with a control character cannot be carried by the
            # newline-delimited failed list, so the guard could not withhold
            # it by name - and a name like "1.0.13<newline>" would make it
            # withhold the real 1.0.13 instead. Could not check: the guard
            # then withholds all of b2b/.
            echo "cannot check: a control character in the name $(printf '%q' "$n") - it cannot be withheld by name"
            exit 2 ;;
    esac
    case "$bn" in
        .*)
            # A dot entry, directory or not: the version loop's glob never
            # sees it, so it would be published unchecked.
            echo "== $n"; echo "  FAIL  a dot entry - nothing hidden belongs under $ROOT/"
            mark_failed "$n"; continue ;;
    esac
    [ -d "$n" ] && [ ! -L "$n" ] && continue
    echo "== $n"
    echo "  FAIL  not a directory - nothing but version directories and latest/ belongs directly under $ROOT/"
    mark_failed "$n"
done

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
    # Already failed by the root pass (a symlinked directory, a control
    # character): it must not join the versions, or it could become latest/'s
    # match or the highest.
    is_failed "$dir" && continue
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
    widget="$(widgetname_of "$dir/sssp_config.xml")"
    # A stray entry beside the descriptor and the package is a fault of this
    # directory - it is withheld - but not of the package: the checks below
    # still run, and a latest/ that serves the same package is still vouched
    # for by it.
    extra="$(extra_entries "$dir" "$widget")"
    if [ -n "$extra" ]; then
        echo "  FAIL  unexpected entries beside the descriptor and the package: $extra"
        mark_failed "$dir"
    fi
    [ "$name" = latest ] && continue

    # The display asks for <widgetname>.wgt and nothing else.
    wgt="$dir/$widget.wgt"
    if [ ! -f "$wgt" ]; then
        echo "  FAIL  the descriptor advertises <widgetname>$widget</widgetname> but $widget.wgt is not here, so a display would 404"
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
    # versions holds the directories whose PACKAGE passed every check (a
    # stray entry beside it may still have failed the directory). One of
    # them serving the same package vouches for latest/.
    match=''
    for dir in ${versions[@]+"${versions[@]}"}; do
        if same_pkg "$ROOT/latest" "$dir"; then
            match="$dir"
            break
        fi
    done
    # None: the same package as a directory whose package failed means
    # latest/ carries the same fault, and it is the directory every panel
    # follows. Checked before "no version directory" so a mirrored fault is
    # never hidden behind that.
    mirrored_fault=''
    if [ -z "$match" ]; then
        for dir in ${candidates[@]+"${candidates[@]}"}; do
            is_failed "$dir" || continue
            [ -f "$dir/sssp_config.xml" ] || continue
            if same_pkg "$ROOT/latest" "$dir"; then
                mirrored_fault="$dir"
                break
            fi
        done
    fi
    if [ -n "$mirrored_fault" ]; then
        echo "  FAIL  $ROOT/latest is identical to $mirrored_fault, which failed above"
        mark_failed "$ROOT/latest"
    elif [ "${#versions[@]}" -eq 0 ]; then
        # No version directory vouches for it: not a proven package, and it
        # is the directory every panel follows - withheld, not advisory.
        echo "  FAIL  no version directory to compare $ROOT/latest with - latest/ must mirror a published version"
        mark_failed "$ROOT/latest"
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
# compared with that one key, and whichever differs is the one charged. A
# same key under a different certificate is a renewal: allowed, but warned
# about the way author-identity-gate.sh warns for production/ - nobody has
# yet watched a display take one over SSSP.
cert_of() {
    local c
    c="$("$here/author-identity.sh" "$1" cert 2>/dev/null || true)"
    case "$c" in none) c='' ;; esac
    printf '%s' "$c"
}
# The accepted key, and the key it replaces. Lower-cased, then required to
# be a sha256 - a key that is not one is "could not check", never a quiet
# non-match that fails the rotation with a message about something else.
accept_key="$(printf '%s' "${CHECK_B2B_ACCEPT_KEY:-}" | tr 'A-F' 'a-f' | tr -d '[:space:]')"
replaced_key="$(printf '%s' "${CHECK_B2B_REPLACED_KEY:-}" | tr 'A-F' 'a-f' | tr -d '[:space:]')"
if [ -z "$accept_key" ] && [ -f "$here/../.github/b2b-accept-key" ]; then
    accept_key="$(sed -n 1p "$here/../.github/b2b-accept-key" | tr 'A-F' 'a-f' | tr -d '[:space:]' || true)"
    replaced_key="$(sed -n 2p "$here/../.github/b2b-accept-key" | tr 'A-F' 'a-f' | tr -d '[:space:]' || true)"
fi
for k in "$accept_key" "$replaced_key"; do
    [ -z "$k" ] && continue
    [[ "$k" =~ ^[0-9a-f]{64}$ ]] || { echo "cannot check: '$k' in .github/b2b-accept-key (or CHECK_B2B_ACCEPT_KEY/CHECK_B2B_REPLACED_KEY) is not a sha256"; exit 2; }
done
# Accepted mode: the file names exactly the key latest/ carries.
accepted=0
latest_key=''
if [ "$latest_ok" -eq 1 ]; then
    lwidget="$(widgetname_of "$ROOT/latest/sssp_config.xml")"
    latest_key="$(key_of "$ROOT/latest/$lwidget.wgt")"
    [ -n "$accept_key" ] && [ "$latest_key" = "$accept_key" ] && accepted=1
fi
ref_key=''
ref_cert=''
ref_src=''
if [ "$accepted" -eq 1 ]; then
    lwidget="$(widgetname_of "$ROOT/latest/sssp_config.xml")"
    ref_key="$accept_key"; ref_cert="$(cert_of "$ROOT/latest/$lwidget.wgt")"; ref_src="$ROOT/latest (key accepted by .github/b2b-accept-key)"
    if [ -n "$base_key" ] && [ "$base_key" != "$accept_key" ]; then
        echo "== author key: ROTATION from $base_key ($CHECK_B2B_BASE) to $accept_key, accepted by .github/b2b-accept-key - every panel on the channel has to be emptied and re-pointed"
        [ -n "${GITHUB_ACTIONS:-}" ] && echo "::warning::b2b/ changes author key (accepted rotation) - panels on the channel will refuse the update until the app is uninstalled on them"
    fi
elif [ -n "$base_key" ]; then
    ref_key="$base_key"; ref_cert="$(cert_of "$base_wgt_tmp")"; ref_src="$CHECK_B2B_BASE's $BASE_PATH/latest"
elif [ "$base_has_latest" -eq 1 ]; then
    # The problem is in the base, not in this change: could not check.
    echo "cannot check: could not read the author key $CHECK_B2B_BASE's $BASE_PATH/latest serves"
    exit 2
elif [ "$latest_ok" -eq 1 ]; then
    lw=("$ROOT/latest/$(widgetname_of "$ROOT/latest/sssp_config.xml").wgt")
    ref_key="$latest_key"
    ref_cert="$(cert_of "${lw[0]}")"
    ref_src="$ROOT/latest"
    if [ -z "$ref_key" ]; then
        echo "  FAIL  could not read the author key of $ROOT/latest"
        mark_failed "$ROOT/latest"
    fi
fi
if [ -n "$ref_key" ]; then
    echo "== author key: every directory must carry $ref_key ($ref_src)"
    to_check=(${versions[@]+"${versions[@]}"})
    # latest/ is compared too unless it IS the reference (then it would only
    # be compared with itself).
    [ "$latest_ok" -eq 1 ] && [ "$ref_src" != "$ROOT/latest" ] && to_check+=("$ROOT/latest")
    key_fails=0
    old_dirs=()
    old_keys=' '
    for dir in ${to_check[@]+"${to_check[@]}"}; do
        is_failed "$dir" && continue
        dw=("$dir/$(widgetname_of "$dir/sssp_config.xml").wgt")
        key="$(key_of "${dw[0]}")"
        if [ -z "$key" ]; then
            echo "  FAIL  could not read the author key of $dir"
            mark_failed "$dir"
            key_fails=$((key_fails + 1))
        elif [ "$accepted" -eq 1 ] && [ "$key" != "$ref_key" ]; then
            # An older key during an accepted rotation: decided below, once
            # every such directory is known.
            old_dirs+=("$dir")
            case "$old_keys" in *" $key "*) ;; *) old_keys="$old_keys$key " ;; esac
        elif [ "$key" != "$ref_key" ]; then
            echo "  FAIL  $dir is signed with author key $key, not $ref_key - panels on the channel would refuse it"
            mark_failed "$dir"
            key_fails=$((key_fails + 1))
        elif [ -n "$ref_cert" ] && [ "$(cert_of "${dw[0]}")" != "$ref_cert" ]; then
            echo "  warn  $dir and $ref_src: same signing key, different certificates - a renewal on one side. Samsung says a renewal over the existing key keeps an app updatable, but says it about the Galaxy store; nobody has watched a display take one over SSSP. Watch the FIRST screen take this update."
            [ -n "${GITHUB_ACTIONS:-}" ] && echo "::warning::$dir and $ref_src carry different certificates over the same key (a renewal on one side) - watch the first screen take the update"
        fi
    done
    # The older-key directories of an accepted rotation: kept for the panels
    # not yet re-pointed, as long as they are what the base already serves
    # (pull-request mode) or, without a base, as long as they agree on ONE
    # older key. A second older key is nobody's channel.
    # One older key at most, in both modes - a second rotation needs the
    # first one's leftovers removed first - and, with a base, only the
    # directories the base already serves.
    several_old=0
    [ "$(printf '%s' "$old_keys" | wc -w | tr -d ' ')" -gt 1 ] && several_old=1
    for dir in ${old_dirs[@]+"${old_dirs[@]}"}; do
        name="$(basename "$dir")"
        okey="$(key_of "$dir/$(widgetname_of "$dir/sssp_config.xml").wgt")"
        if [ "$several_old" -eq 1 ]; then
            echo "  FAIL  $dir carries one of several older keys - nothing says which one panels run; only one older key may remain (remove the earlier rotation's leftovers first)"
            mark_failed "$dir"
            key_fails=$((key_fails + 1))
        elif [ "$base_has_latest" -eq 1 ]; then
            if git cat-file -e "$CHECK_B2B_BASE:$BASE_PATH/$name/sssp_config.xml" 2>/dev/null; then
                echo "  ok    $dir still carries the older key - kept for panels not yet re-pointed"
            else
                echo "  FAIL  $dir carries an older key and $CHECK_B2B_BASE does not serve it - a new directory must carry the accepted key"
                mark_failed "$dir"
                key_fails=$((key_fails + 1))
            fi
        elif [ -n "$replaced_key" ] && [ "$okey" = "$replaced_key" ]; then
            # No base (the publish guard): only the key the accept file says
            # is being replaced is an older key. Anything else is a package
            # on a third key, admitted by nothing.
            echo "  ok    $dir still carries the replaced key - kept for panels not yet re-pointed"
        else
            echo "  FAIL  $dir carries key $okey, which is neither the accepted key nor the replaced key named on line 2 of .github/b2b-accept-key"
            mark_failed "$dir"
            key_fails=$((key_fails + 1))
        fi
    done
    [ "$key_fails" -eq 0 ] && echo "  ok    every directory carries it"
elif [ "${#versions[@]}" -gt 0 ]; then
    # No usable reference (latest/ failed, or its key cannot be read) and no
    # base, so nothing says which key the fleet runs. The version
    # directories must then agree among themselves; if they do not, there
    # is no way to tell the foreign one from the right one, and every one
    # of them is withheld until latest/ is fixed. Safe either way: a
    # withheld directory means panels keep the build they have.
    echo "== author key: no usable reference and no base - the versions must agree"
    first_key=''
    disagree=0
    for dir in ${versions[@]+"${versions[@]}"}; do
        # A directory already failed (a stray .wgt beside the package, say)
        # must not vote: its stray could carry any key.
        is_failed "$dir" && continue
        key="$(key_of "$dir/$(widgetname_of "$dir/sssp_config.xml").wgt")"
        if [ -z "$key" ]; then
            echo "  FAIL  could not read the author key of $dir"
            mark_failed "$dir"
            continue
        fi
        if [ -z "$first_key" ]; then
            first_key="$key"
        elif [ "$key" != "$first_key" ]; then
            disagree=1
        fi
    done
    if [ "$disagree" -eq 1 ]; then
        echo "  FAIL  the version directories carry different author keys and nothing says which one the fleet runs - all withheld until latest/ is fixed"
        for dir in ${versions[@]+"${versions[@]}"}; do is_failed "$dir" || mark_failed "$dir"; done
    elif [ -n "$first_key" ]; then
        echo "  ok    every version directory carries $first_key"
    fi
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
    elif ! [[ "$base_ver" =~ ^[0-9]+$ ]]; then
        echo "  note  $CHECK_B2B_BASE's $BASE_PATH/latest advertises <ver>$base_ver</ver>, not an integer - cannot compare; a display following it has never re-downloaded anyway (served-baseline.sh calls this 'legacy')"
    else
        echo "  ok    <ver>$new_ver</ver> is above $CHECK_B2B_BASE's <ver>$base_ver</ver>"
    fi
fi
if [ -n "${CHECK_B2B_BASE:-}" ] && git cat-file -e "$CHECK_B2B_BASE:$BASE_PATH" 2>/dev/null; then
    # A version directory the base already serves must still exist: a panel
    # may be pointed at it (README step 2), and nothing else would notice
    # its descriptor turning into a 404.
    while IFS= read -r served; do
        [ -n "$served" ] || continue
        [ "$served" = latest ] && continue
        if [ ! -d "$ROOT/$served" ]; then
            # Gone. Allowed only if the base's copy carries a key other than
            # the key the base's latest/ carries: a directory left behind by
            # a rotation, which no panel on the current key can run anyway.
            swidget="$(git cat-file blob "$CHECK_B2B_BASE:$BASE_PATH/$served/sssp_config.xml" 2>/dev/null | sed -n 's|.*<widgetname>\(.*\)</widgetname>.*|\1|p' | head -1 || true)"
            st="$(mktemp)"; tmpfiles="$tmpfiles $st"
            skey=''
            if git cat-file blob "$CHECK_B2B_BASE:$BASE_PATH/$served/$swidget.wgt" > "$st" 2>/dev/null; then
                skey="$(key_of "$st")"
            fi
            if [ -n "$skey" ] && [ -n "$base_key" ] && [ "$skey" != "$base_key" ]; then
                echo "  ok    $BASE_PATH/$served is gone, and it carried a key other than the one $CHECK_B2B_BASE's latest/ carries - a rotation leftover, removable"
            else
                echo "  FAIL  $BASE_PATH/$served is served by $CHECK_B2B_BASE but is gone from this tree - a panel pointed at it would 404; published versions are not removed"
                fail=1
            fi
        fi
    done <<< "$(git ls-tree --name-only "$CHECK_B2B_BASE:$BASE_PATH" 2>/dev/null | while IFS= read -r e; do git cat-file -e "$CHECK_B2B_BASE:$BASE_PATH/$e/sssp_config.xml" 2>/dev/null && echo "$e"; done || true)"
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
