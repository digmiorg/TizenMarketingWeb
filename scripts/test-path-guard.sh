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
    local script="$1" label="$2" value="$3" want="$4" out status
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
    check "$script" GUARD '.build/../src'                 reject
    check "$script" GUARD '.build/a/../../../sibling'     reject   # deleted a sibling repo's .git
    check "$script" GUARD '.build/x/../../src'            reject
    check "$script" GUARD '.build/a/../../src/js'         reject   # recursive self-copy until ENAMETOOLONG
    check "$script" GUARD '.build/a/../..'                reject
    check "$script" GUARD '.build/'                       reject   # trailing glob also matches nothing
    check "$script" GUARD '.build'                        reject   # the root itself, not beneath it
    check "$script" GUARD '../elsewhere'                  reject
    check "$script" GUARD '/tmp/evil'                     reject
    check "$script" GUARD 'src'                           reject

    # Must be allowed, or the build cannot run -- including on a fresh checkout
    # where .build/ does not exist yet, which is the CI case.
    check "$script" GUARD '.build/package'                accept
    check "$script" GUARD '.build/out'                    accept
    check "$script" GUARD '.build/seller-office/package'  accept
    check "$script" GUARD '.build/deeply/nested/dir'      accept
done

# CDPATH must not make `cd` print its pick, which would return two lines and
# point the guard at a different tree from the one rm -rf walks.
decoy="$(mktemp -d)"; mkdir -p "$decoy/.build"
if CDPATH="$decoy" bash -c "$(load_guard scripts/build-wgt.sh); assert_under_build GUARD '.build/package'" 2>&1; then
    pass=$((pass + 1))
else
    fail=$((fail + 1)); printf '  FAIL CDPATH set broke a valid path\n'
fi
rm -rf "$decoy"

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
