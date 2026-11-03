#!/usr/bin/env bash
#
# Print the `<ver>` a new release has to beat, measured across EVERY directory
# the fleet is served from — `production/latest/` and `production/`, not just
# the first one.
#
# Both carry a descriptor, a given screen's configured URL may be either, and
# both get overwritten with the same package. So the number to beat is the
# HIGHEST of the two: clearing only the lower one would publish a decrease to
# the other and freeze every screen pointed at it on the build it already has,
# silently and permanently. They hold the same bytes today; nothing enforces
# that, and a hand edit or a partial revert is all it takes to part them.
#
# Prints one token on stdout, and what it read on stderr:
#   <integer>  the highest integer <ver> served anywhere
#   legacy     descriptors exist but none states an integer <ver>
#   none       no descriptor is served at all
#
# Usage: scripts/served-baseline.sh [dir...]   (default: the two served dirs)

set -euo pipefail

dirs=("$@")
[ "${#dirs[@]}" -gt 0 ] || dirs=(production/latest production)

baseline=''
seen=0

for dir in "${dirs[@]}"; do
    cfg="$dir/sssp_config.xml"
    [ -f "$cfg" ] || continue
    seen=1
    # `|| true`: head closes the pipe, and under pipefail that SIGPIPE would
    # take the script down before it could report what it read.
    raw="$(sed -n 's|.*<ver>\(.*\)</ver>.*|\1|p' "$cfg" | head -1 || true)"
    echo "$dir advertises <ver>${raw:-nothing}" >&2
    if [[ "$raw" =~ ^[0-9]+$ ]]; then
        if [ -z "$baseline" ] || [ "$raw" -gt "$baseline" ]; then
            baseline="$raw"
        fi
    fi
done

if [ -n "$baseline" ]; then
    echo "$baseline"
elif [ "$seen" = 1 ]; then
    echo legacy
else
    echo none
fi
