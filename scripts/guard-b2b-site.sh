#!/usr/bin/env bash
#
# Keep a broken b2b/ off the published site without holding production/ hostage.
#
# b2b/ is hand-published and has no build job that could fail; the three
# workflows that publish the Pages site (Deploy site, Release widget, Promote
# release) each `git archive` the whole tree, b2b/ included. If parts of b2b/
# fail scripts/check-b2b.sh this does NOT fail the deploy: Deploy site is also
# the rollback path for production/latest/, and a bad b2b/ must never stand
# between a revert and the panels. Instead exactly the failing directories are
# dropped from the assembled site and an ::error:: plus a step-summary block
# are raised. latest/ - the directory every panel on the channel follows - is
# dropped only when latest/ itself is what is broken; a bad new version
# directory beside a good latest/ leaves the fleet's path serving. A display
# whose directory was dropped gets a 404 on the descriptor and is expected to
# keep the build it has (documented SSSP behaviour, not yet measured for TBM
# Custom App URL); it resumes once b2b/ is fixed on main.
#
# Three outcomes, kept apart on purpose:
#   * no b2b/ in the site      -> nothing to guard, exit 0, no error;
#   * check-b2b.sh exits 2     -> a tool is missing: that is a runner problem,
#                                 not a content problem, so this step FAILS
#                                 rather than drop a correct b2b/;
#   * check-b2b.sh exits 1     -> drop the failing directories, exit 0.
#
# Usage: scripts/guard-b2b-site.sh <assembled-site-dir>   (run from the repo root)

set -euo pipefail

SITE="${1:?usage: guard-b2b-site.sh <assembled-site-dir>}"
here="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$SITE/b2b" ]; then
    echo "no $SITE/b2b/ - nothing to guard"
    exit 0
fi

# Check the b2b/ that is about to be published - the one in the assembled
# site - not the working tree's, which is what the "git archive, not a copy
# of the working tree" comments in the workflows are about.
list="$(mktemp)"
rc=0
CHECK_B2B_FAILED_LIST="$list" "$here/check-b2b.sh" "$SITE/b2b" || rc=$?
case "$rc" in
    0) rm -f "$list"; exit 0 ;;
    2) rm -f "$list"; echo "::error::check-b2b.sh could not run (a tool is missing on this runner) - refusing to guess whether b2b/ is good"; exit 1 ;;
esac

dropped=''
while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    case "$dir" in
        "$SITE"/b2b/*) ;;
        *) echo "::error::refusing to remove '$dir': not under $SITE/b2b"; exit 1 ;;
    esac
    rm -rf -- "$dir"
    [ ! -e "$dir" ] || { echo "::error::could not remove $dir"; exit 1; }
    dropped="$dropped ${dir#"$SITE"/}"
done < "$list"
rm -f "$list"

if [ -z "$dropped" ]; then
    # check-b2b.sh failed on something it could not pin to a directory (for
    # example latest/ with no version directory to compare with). Nothing is
    # removed; the error is still raised so someone looks.
    dropped=' (nothing removed - see the check output above)'
fi

echo "::error::b2b/ fails scripts/check-b2b.sh - publishing this site WITHOUT:$dropped. production/ and its rollback path are not blocked. Panels pointed at a dropped directory keep what they have; fix b2b/ on main to resume."
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
        echo "### b2b/ partly withheld from this deploy"
        echo
        echo "\`scripts/check-b2b.sh\` failed, so these directories were not published:"
        echo
        for d in $dropped; do echo "- \`$d\`"; done
        echo
        echo "\`production/\` was published as usual. Panels pointed at a withheld directory get a 404 on the descriptor and keep the build they have. Fix \`b2b/\` on \`main\` to resume."
    } >> "$GITHUB_STEP_SUMMARY"
fi
exit 0
