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
# Four outcomes, kept apart on purpose - and none of them fails the deploy,
# because every publish workflow is also production/'s rollback path:
#   * no b2b/ in the site      -> nothing to guard, exit 0, no error;
#   * check-b2b.sh exits 1 and
#     wrote its verdict        -> drop exactly the failing directories;
#   * check-b2b.sh could not
#     check (exit 2, cut short,
#     any other status)        -> an unchecked b2b/ is never published:
#                                 ALL of b2b/ is withheld, with an ::error::
#                                 and a step-summary block, and the deploy
#                                 goes on without it;
#   * the guard's own invariant
#     breaks (a path it refuses
#     to remove, a failed rm)  -> exit 1: the guard itself is broken.
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
# The list file must not exist before the check: check-b2b.sh writes it only
# when it reached a verdict, so "exit 1 and no list" means it was cut short
# (bash 3.2 reports a lost exec bit as 1, not 126).
list="$(mktemp)"
rm -f "$list"
rc=0
CHECK_B2B_FAILED_LIST="$list" CHECK_B2B_BASE_PATH=b2b "$here/check-b2b.sh" "$SITE/b2b" || rc=$?
# Everything that is not a verdict - exit 2 (a tool missing, the ERR trap, a
# failed diff/cmp, a base that does not resolve), exit 1 without a written
# list (cut short; bash 3.2 reports a lost exec bit as 1), a signal, any
# other status - withholds ALL of b2b/. Never publish an unchecked b2b/, and
# never block production/ for it.
withhold_all() {
    rm -f "$list"
    if [ -d "$SITE/b2b" ]; then
        rm -rf -- "$SITE/b2b"
        [ ! -e "$SITE/b2b" ] || { echo "::error::could not remove $SITE/b2b"; exit 1; }
    fi
    echo "::error::$1 - b2b/ WITHHELD IN FULL from this deploy; production/ and its rollback path are published as usual. Fix the check (or the runner) and redeploy to resume b2b/."
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
        {
            echo "### b2b/ withheld in full: it could not be checked"
            echo
            echo "$1. An unchecked \`b2b/\` is never published, so none of it was. \`production/\` was published as usual. Panels on \`b2b/latest/\` get a 404 on the descriptor and are expected to keep the build they have (documented SSSP behaviour, not yet measured for TBM Custom App URL)."
        } >> "$GITHUB_STEP_SUMMARY"
    fi
    exit 0
}
case "$rc" in
    0) rm -f "$list"; exit 0 ;;
    1) [ -f "$list" ] || withhold_all "check-b2b.sh exited 1 without writing its verdict (cut short)" ;;
    2) withhold_all "check-b2b.sh could not check b2b/ (see its output above)" ;;
    *) withhold_all "check-b2b.sh exited $rc, which is not a verdict" ;;
esac

dropped=()
while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    # Only a direct child of $SITE/b2b, and never a '..' component (a name
    # that merely contains two dots, such as a typo'd version, is a child
    # like any other and is removed like any other).
    case "/$dir/" in
        */../*) echo "::error::refusing to remove '$dir'"; exit 1 ;;
    esac
    case "$dir" in
        "$SITE"/b2b/|"$SITE"/b2b) echo "::error::refusing to remove '$dir'"; exit 1 ;;
        "$SITE"/b2b/*/*) echo "::error::refusing to remove '$dir': not a direct child of $SITE/b2b"; exit 1 ;;
        "$SITE"/b2b/*) ;;
        *) echo "::error::refusing to remove '$dir': not under $SITE/b2b"; exit 1 ;;
    esac
    rm -rf -- "$dir"
    [ ! -e "$dir" ] || { echo "::error::could not remove $dir"; exit 1; }
    dropped+=("${dir#"$SITE"/}")
done < "$list"
rm -f "$list"

if [ "${#dropped[@]}" -eq 0 ]; then
    # check-b2b.sh failed on something it could not pin to a directory (for
    # example latest/ with no version directory to compare with). Nothing is
    # removed; the error is still raised so someone looks.
    echo "::error::b2b/ fails scripts/check-b2b.sh on something not tied to one directory (see its output above) - nothing withheld, site published as committed. production/ and its rollback path are not blocked."
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
        {
            echo "### b2b/ fails its check"
            echo
            echo "\`scripts/check-b2b.sh\` failed on something not tied to one directory; nothing was withheld. See the step output, and fix \`b2b/\` on \`main\`."
        } >> "$GITHUB_STEP_SUMMARY"
    fi
    exit 0
fi

echo "::error::b2b/ fails scripts/check-b2b.sh - publishing this site WITHOUT: ${dropped[*]}. production/ and its rollback path are not blocked. Panels pointed at a dropped directory keep what they have; fix b2b/ on main to resume."
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
        echo "### b2b/ partly withheld from this deploy"
        echo
        echo "\`scripts/check-b2b.sh\` failed, so these directories were not published:"
        echo
        for d in "${dropped[@]}"; do echo "- \`$d\`"; done
        echo
        echo "\`production/\` was published as usual. Panels pointed at a withheld directory get a 404 on the descriptor and are expected to keep the build they have (documented SSSP behaviour, not yet measured for TBM Custom App URL). Fix \`b2b/\` on \`main\` to resume."
    } >> "$GITHUB_STEP_SUMMARY"
fi
exit 0
