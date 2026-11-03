#!/usr/bin/env bash
#
# Confirm that every directory a display may be pointed at is actually serving
# one particular package.
#
# Deploying is not serving, and a descriptor alone proves nothing. A display
# reads `<ver>`, then fetches the .wgt and checks it against `<size>`; a fresh
# descriptor served beside a stale package is the failure that looks exactly
# like success. So this checks by bytes.
#
# Two workflows need it — the one that publishes a new build and the one that
# promotes an already-published build to the fleet — and a polling loop kept in
# two copies is a polling loop that stops matching.
#
# Usage: scripts/check-served.sh <base-url> <sssp-ver> <widget-name> <reference.wgt> <dir> [dir...]

set -euo pipefail

BASE="${1:?usage: check-served.sh <base-url> <sssp-ver> <widget-name> <reference.wgt> <dir>...}"
SSSP_VER="${2:?missing sssp-ver}"
WIDGET="${3:?missing widget-name}"
REFERENCE="${4:?missing reference .wgt}"
shift 4
[ "$#" -gt 0 ] || { echo "no directories to check" >&2; exit 1; }

# The deployment's page_url carries a trailing slash today, but the action's own
# test fixtures do not, so do not depend on either.
BASE="${BASE%/}/"

# The runner has sha256sum; a Mac has shasum. This script is also the thing to
# run by hand after a revert, so it should work in both places.
sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

[ -f "$REFERENCE" ] || { echo "::error::reference package $REFERENCE does not exist"; exit 1; }
reference_sha="$(sha256 "$REFERENCE")"
echo "reference sha256:$reference_sha  ($REFERENCE)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 15 tries 10s apart: 2m20s of sleeping per directory, and with curl's own
# --max-time 20 a worst case of 5m20s per directory — up to three directories,
# inside a 30-minute job that deploying may already have spent ten minutes of.
# No sleep after the last try.
attempts="${CHECK_SERVED_ATTEMPTS:-15}"
interval="${CHECK_SERVED_INTERVAL:-10}"

for dir in "$@"; do
    url="$BASE$dir/sssp_config.xml"
    served_ver=''
    fetched=0
    ok=0

    for n in $(seq 1 "$attempts"); do
        if body="$(curl -fsS --max-time 20 "$url" 2>/dev/null)"; then
            fetched=1
            served_ver="$(printf '%s' "$body" \
                | sed -n 's|.*<ver>\([0-9]*\)</ver>.*|\1|p' | head -1 || true)"
            if [ "$served_ver" = "$SSSP_VER" ]; then
                ok=1
                break
            fi
            echo "$dir try $n/$attempts: serving <ver> '${served_ver:-absent or non-integer}', waiting for $SSSP_VER"
        else
            # Kept apart from the stale case on purpose: a 404 and a
            # not-yet-propagated file both read as nothing, and they call for
            # completely different things to be looked at.
            echo "$dir try $n/$attempts: $url does not answer yet"
        fi
        if [ "$n" -lt "$attempts" ]; then
            sleep "$interval"
        fi
    done

    if [ "$ok" != 1 ]; then
        if [ "$fetched" = 0 ]; then
            echo "::error::$url never answered. The commit landed and the"
            echo "::error::deployment reported success, so the file is missing from"
            echo "::error::what was deployed — check what git archive HEAD contained."
        else
            echo "::error::$url serves <ver> '${served_ver:-absent or non-integer}'"
            echo "::error::instead of $SSSP_VER. The file is there but it is not this"
            echo "::error::package, so an older tree was deployed."
        fi
        exit 1
    fi

    if ! curl -fsS --max-time 180 -o "$WORK/served.wgt" "$BASE$dir/$WIDGET.wgt"; then
        echo "::error::$BASE$dir/$WIDGET.wgt could not be fetched, while the"
        echo "::error::descriptor beside it is this package's. A display would read"
        echo "::error::<ver>$SSSP_VER, try the package and get nothing. Check that"
        echo "::error::the .wgt was committed under the name the descriptor gives."
        exit 1
    fi

    served_sha="$(sha256 "$WORK/served.wgt")"
    if [ "$served_sha" != "$reference_sha" ]; then
        echo "::error::$BASE$dir/$WIDGET.wgt is not the package this run published."
        echo "::error::served sha256:$served_sha"
        echo "::error::The descriptor advertises <ver>$SSSP_VER and a <size> taken"
        echo "::error::from a different file, so every display will fetch the"
        echo "::error::descriptor and then decline the download without saying why."
        exit 1
    fi

    echo "$dir: serving <ver>$SSSP_VER and the exact package we published"
done
