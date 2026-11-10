#!/usr/bin/env bash
#
# Keep a broken b2b/ off the published site without holding production/ hostage.
#
# b2b/ is hand-published and has no build job that could fail; the three
# workflows that publish the Pages site (Deploy site, Release widget, Promote
# release) each `git archive` the whole tree, b2b/ included. If b2b/ fails
# scripts/check-b2b.sh this does NOT fail the deploy: Deploy site is also the
# rollback path for production/latest/, and a bad b2b/ must never stand
# between a revert and the panels. Instead b2b/ is dropped from the assembled
# site and an ::error:: is raised. A display following b2b/latest/ then gets a
# 404 on the descriptor and is expected to keep the build it has (documented
# SSSP behaviour, not yet measured for TBM Custom App URL); new installs
# resume once b2b/ is fixed on main.
#
# Usage: scripts/guard-b2b-site.sh <assembled-site-dir>   (run from the repo root)

set -euo pipefail

SITE="${1:?usage: guard-b2b-site.sh <assembled-site-dir>}"
here="$(cd "$(dirname "$0")" && pwd)"

# Check the b2b/ that is about to be published - the one in the assembled
# site - not the working tree's, which is what the "git archive, not a copy
# of the working tree" comments in the workflows are about.
if "$here/check-b2b.sh" "$SITE/b2b"; then
    exit 0
fi

echo "::error::b2b/ fails scripts/check-b2b.sh - publishing this site WITHOUT b2b/ so production/ and its rollback path are not blocked. Panels on b2b/latest/ keep what they have; fix b2b/ on main to resume."
if [ -d "$SITE/b2b" ]; then
    rm -rf -- "$SITE/b2b"
fi
[ ! -e "$SITE/b2b" ] || { echo "::error::could not remove $SITE/b2b"; exit 1; }
