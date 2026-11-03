#!/usr/bin/env bash
#
# Decide whether a candidate .wgt will be accepted as an update by the displays
# that are running what is served today.
#
# A display refuses an update signed by a different author than the one it
# already carries. What counts as the same author — the key, or the whole
# certificate — is argued with sources at the top of scripts/author-identity.sh;
# the short version is that a renewal is a new certificate over the existing
# key, Samsung states that such an app still updates, and states it about
# Galaxy store rather than about sideloaded SSSP. So this reports three
# outcomes rather than two, and the middle one is a warning rather than a
# silence.
#
# EVERY served directory is consulted, not just production/latest/. Both carry
# a descriptor and a package, a given screen's URL may be either, and nothing
# enforces that they agree. A package signed with a different key sitting in
# the one that is not checked would be replaced without a word.
#
# Each directory's own <widgetname> says which file is live there. Taking the
# candidate's name instead would report "nothing published yet" after a rename
# and skip the comparison entirely.
#
# THE DESCRIPTOR IS WHAT MAKES A DIRECTORY SERVED, whatever files sit beside
# it. That single rule settles the three awkward states, and it settles them
# the way a display behaves:
#   * no descriptor anywhere — a display cannot read <ver>, so nothing is
#     running anything from a served directory and there is no installed
#     identity to compare against. Fine, and the only answer that lets a first
#     release happen at all.
#   * a package with no descriptor beside it — a display 404s on the descriptor
#     and keeps running what it has. Nothing can install, so nothing to check.
#   * a descriptor naming a package that is not there — a display reads <ver>,
#     decides to upgrade, fetches the .wgt and 404s. That is a fault already in
#     progress, and it makes "will the fleet accept this?" unanswerable,
#     because what the fleet runs cannot be established. Fatal.
#
# Exit codes, so that each workflow can apply its own policy:
#   0  the same author — safe to publish (a renewal prints a ::warning::)
#   2  a different signing KEY — the installed estate will not update
#   1  the served state is broken and the question cannot be answered
#
# Usage: scripts/author-identity-gate.sh <candidate.wgt> [served-dir...]

set -euo pipefail

CANDIDATE="${1:?usage: author-identity-gate.sh <candidate.wgt> [served-dir...]}"
shift
# Not the bare relative path: this has to work from somewhere other than the
# repository root, the way its two sibling scripts already do.
IDENTITY="$(cd "$(dirname "$0")" && pwd)/author-identity.sh"
dirs=("$@")
[ "${#dirs[@]}" -gt 0 ] || dirs=(production/latest production)

[ -f "$CANDIDATE" ] || { echo "::error::$CANDIDATE does not exist"; exit 1; }

# `||` on every call: this script's exit codes are a verdict (2 means "a
# different signing key", which a workflow may be told to accept), while
# author-identity.sh's 2 means it was called wrongly. Letting that propagate
# would turn "I could not read this" into "a different author, go ahead".
# The message goes to stderr: every call site is a command substitution, so
# anything written to stdout is captured into a variable instead of reaching
# the log. `exit` here ends that subshell, and under `set -e` the failed
# assignment then ends the script.
read_identity() {
    "$IDENTITY" "$1" ${2+"$2"} || {
        echo "::error::could not read the author ${2:-key} of $1" >&2
        exit 1
    }
}

now_key="$(read_identity "$CANDIDATE")"
if [ "$now_key" = none ]; then
    echo "::error::$CANDIDATE carries no author signature at all"
    exit 1
fi
echo "this key: $now_key"

# Once, not once per served directory.
now_cert="$(read_identity "$CANDIDATE" cert)"

seen=0
differs=0
renewed=0

for dir in "${dirs[@]}"; do
    cfg="$dir/sssp_config.xml"
    [ -f "$cfg" ] || continue

    # `|| true`: head closes the pipe, and under pipefail that SIGPIPE would
    # take the script down before it could report what it read.
    name="$(sed -n 's|.*<widgetname>\([^<]*\)</widgetname>.*|\1|p' "$cfg" | head -1 || true)"
    if [ -z "$name" ]; then
        echo "::error::$cfg has no <widgetname>, so there is no telling which"
        echo "::error::package is live in $dir."
        exit 1
    fi

    live="$dir/$name.wgt"
    if [ ! -f "$live" ]; then
        echo "::error::$cfg advertises <widgetname>$name and $live is not there."
        echo "::error::That is not 'nothing published yet' — it is a descriptor and a"
        echo "::error::package that disagree, which a display resolves by failing the"
        echo "::error::install. Fix $dir first."
        exit 1
    fi

    seen=1
    was_key="$(read_identity "$live")"
    echo "$live key: $was_key"

    if [ "$was_key" != "$now_key" ]; then
        differs=1
        continue
    fi

    was_cert="$(read_identity "$live" cert)"
    if [ "$was_cert" != "$now_cert" ]; then
        renewed=1
        echo "::warning::$live: same signing key, a different certificate. That is what"
        echo "::warning::a renewal looks like, and this gate treats it as the same author."
        echo "::warning::Samsung states a renewal over the existing key keeps an app"
        echo "::warning::updatable, but states it about Galaxy store; nobody here has"
        echo "::warning::confirmed it through SSSP. Watch the FIRST screen take this"
        echo "::warning::update before trusting the rest of the estate to it."
        echo "::warning::live certificate: $was_cert"
        echo "::warning::this certificate: $now_cert"
    fi
done

if [ "$seen" = 0 ]; then
    echo "nothing published yet — no identity to compare against"
    exit 0
fi

if [ "$differs" = 1 ]; then
    exit 2
fi

if [ "$renewed" = 0 ]; then
    echo "the same signing key and the same certificate as everything served"
fi
exit 0
