#!/usr/bin/env bash
#
# The build scripts' path guard, exercised against the inputs that broke it.
#
# This file exists because the guard shipped with a hole: it rejected
# `.build/../src` but accepted `.build/a/../../../sibling-repo`, which deleted
# `.git` and `.env` in a sibling repository with exit 0. A guard whose whole job
# is to stand in front of `rm -rf` must not be reasoned about -- it must be run.
#
# Usage: scripts/test-path-guard.sh

set -euo pipefail

cd "$(dirname "$0")/.."

pass=0
fail=0

# The guard lives in both scripts. Sourcing is not an option (they run a build),
# so the functions are extracted and evaluated on their own.
load_guard() {
    sed -n '/^resolve_path() {/,/^}/p;/^assert_under_build() {/,/^}/p' "$1"
}

check() {
    local script="$1" value="$2" want="$3" out status
    out="$(bash -c "$(load_guard "$script"); assert_under_build GUARD '$value'" 2>&1)" && status=0 || status=$?

    if [ "$want" = reject ] && [ "$status" -ne 0 ]; then
        pass=$((pass + 1))
    elif [ "$want" = accept ] && [ "$status" -eq 0 ]; then
        pass=$((pass + 1))
    else
        fail=$((fail + 1))
        printf '  FAIL %-18s %-34s wanted %s, got exit %s %s\n' \
            "$(basename "$script")" "$value" "$want" "$status" "$out"
    fi
}

for script in scripts/build-wgt.sh scripts/build-seller-office-wgt.sh; do
    # Must be refused: every one of these reached `rm -rf` under an earlier
    # version of the guard, or would under a plain string prefix test.
    check "$script" '.build/../src'                 reject
    check "$script" '.build/a/../../../sibling'     reject   # deleted a sibling repo's .git
    check "$script" '.build/x/../../src'            reject
    check "$script" '.build/a/../../src/js'         reject   # recursive self-copy until ENAMETOOLONG
    check "$script" '.build/a/../..'                reject
    check "$script" '.build/'                       reject   # trailing glob also matches nothing
    check "$script" '.build'                        reject   # the root itself, not beneath it
    check "$script" '../elsewhere'                  reject
    check "$script" '/tmp/evil'                     reject
    check "$script" 'src'                           reject

    # Must be allowed, or the build cannot run -- including on a fresh checkout
    # where .build/ does not exist yet, which is the CI case.
    check "$script" '.build/package'                accept
    check "$script" '.build/out'                    accept
    check "$script" '.build/seller-office/package'  accept
    check "$script" '.build/deeply/nested/dir'      accept
done

# CDPATH must not make `cd` print its pick. Asserting the RESOLVED VALUE, not
# just the exit status, and in BOTH worktree states -- because exit status alone
# does not catch this. Measured on a mutant with `CDPATH=` removed:
#
#   .build/ present on disk -> 28/1, caught
#   .build/ absent (a fresh clone, i.e. CI) -> 29/0, MISSED
#
# With no .build/ the resolver falls back to `p="."`, and `cd .` consults CDPATH
# too, so root AND abs both pick up the decoy prefix and the comparison still
# agrees. A test that is green against the very regression it was written for is
# not a test, and one whose result depends on untracked worktree state is flaky
# on top of that.
cdpath_case() {
    local state="$1" repo="$2" decoy="$3" got want
    # Resolved the same way the function resolves, or the expectation fails on
    # macOS where /var is a symlink to /private/var.
    want="$(cd "$repo" && pwd -P)/.build"
    got="$(cd "$repo" && CDPATH="$decoy" bash -c "$(load_guard "$OLDPWD/scripts/build-wgt.sh"); resolve_path .build")"
    if [ "$got" = "$want" ]; then
        pass=$((pass + 1))
    else
        fail=$((fail + 1))
        printf '  FAIL CDPATH/%-16s resolve_path .build = %s (wanted exactly %s)\n' \
            "$state" "$(printf '%s' "$got" | tr '\n' '|')" "$want"
    fi
}

sandbox="$(mktemp -d)"
decoy="$sandbox/decoy"; mkdir -p "$decoy/.build"

mkdir -p "$sandbox/with/.build"
cdpath_case "with .build"    "$sandbox/with" "$decoy"

mkdir -p "$sandbox/without"
cdpath_case "without .build" "$sandbox/without" "$decoy"

rm -rf "$sandbox"

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
