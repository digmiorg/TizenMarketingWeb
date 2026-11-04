#!/usr/bin/env python3
"""Drive the real inner signing script from release-widget.yml against a stub
`tizen`, so that the bugs this step has already had stay fixed.

    python3 scripts/signtest.py [path/to/release-widget.yml]
    python3 scripts/signtest.py --mutate   # prove the cases bite, ~2 minutes

No third-party modules: the stock `python3` on a runner or a Mac will do.
`shellcheck` is used when it is on PATH and reported as skipped when it is not.
Exits non-zero if any case fails.

The script under test is not a copy: it is cut out of the workflow file, so a
change to the YAML changes what runs here. Each case drives it with a different
`tizen cli-config -l` answer and asserts the path it resolves, the key it
writes, the arguments it passes to `security-profiles add`, and whether it
fails or warns.

Every case here is a bug this step shipped, or shipped in review:

* the profiles file is in `${TIZEN_HOME}-data`, not under `$HOME`, and not in
  `tools/certificate-generator` — run 41796421422 died on the last of those;
* the key is `default.profiles.path` in full, and that is the one written;
* `add` needs `-f`, or it refuses when no profiles.xml exists yet;
* the write is guarded, or a CLI that refuses the key kills the step;
* neither the path nor the step's output may carry a stray space or CR;
* nothing inside the block may contain an apostrophe, because the whole block
  is a single-quoted argument to `bash -c`.
"""
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

SELF = str(pathlib.Path(__file__).resolve())
DEFAULT_WF = (pathlib.Path(SELF).parent.parent
              / '.github/workflows/release-widget.yml')
args = [a for a in sys.argv[1:] if a != '--mutate']
MUTATE = '--mutate' in sys.argv[1:]
SRC = pathlib.Path(args[0]) if args else DEFAULT_WF
OPENER = "dbus-run-session -- bash -euo pipefail -c '"


def die(message):
    """Fail the run. Not `assert`: `python -O` throws those away."""
    sys.exit('signtest.py: ' + message)


def extract(raw):
    """The body of the `bash -c` block, exactly as the shell receives it.

    Cut from the file text rather than from a parsed workflow, so that this
    needs no YAML library. As long as the opener is the shallowest line of
    its `run:` block — the only layout this step has ever had, and a
    shallower line is an error rather than a silent reindent — what comes
    out is what a parser would hand over, byte for byte except on lines that
    hold nothing but whitespace, where a parser keeps the overshoot and this
    does not. bash cannot tell those two apart. Verified against PyYAML on
    this workflow, on thirteen variants of it and on six adversarial
    layouts, 2026-11-04.
    """
    lines = raw.splitlines()
    starts = [i for i, l in enumerate(lines) if l.endswith(OPENER)]
    if len(starts) != 1:
        die(f'expected exactly one `bash -c` signing block, found '
            f'{len(starts)}')
    first = starts[0]
    base = len(lines[first]) - len(lines[first].lstrip())
    body = []
    for line in lines[first + 1:]:
        if line.strip() == "'":
            return '\n'.join(body)
        if line.strip() and not line.startswith(' ' * base):
            # Either the block is laid out in a way this cannot dedent, or
            # the closing apostrophe is missing and this is already the next
            # step. Both are worth stopping for, and the line says which.
            die(f'ran past the end of the signing block at a line shallower '
                f'than its opener: {line!r}')
        body.append(line[base:] if line.strip() else '')
    die('the signing block is never closed')


print(f'workflow under test: {SRC}')
if not SRC.is_file():
    die(f'no such workflow file: {SRC}')
inner = extract(SRC.read_text())
if '${{' in inner:
    die('the inner script interpolates a workflow expression')
# The block is a single-quoted argument to `bash -c`, so one apostrophe ends
# it and the rest of the script becomes shell words. The extraction above
# closes the block on a line that is ONLY an apostrophe, so it does not notice
# a stray one mid-line and would happily test a block the shell could never
# run: actionlint caught exactly that on 2026-11-04, this suite did not.
if "'" in inner:
    die('apostrophe inside the single-quoted bash -c block: '
        + next(l for l in inner.splitlines() if "'" in l).strip())

# it must at least parse on its own
chk = subprocess.run(['bash', '-n', '-c', inner], capture_output=True,
                     text=True)
if chk.returncode != 0:
    die('bash -n rejected the inner script:\n' + chk.stderr)
print('bash -n inner script: ok')
if shutil.which('shellcheck'):
    sc = subprocess.run(['shellcheck', '-s', 'bash', '-'], input=inner,
                        capture_output=True, text=True)
    if sc.returncode != 0:
        die('shellcheck is not clean on the inner script:\n' + sc.stdout)
    print('shellcheck inner script: clean')
else:
    print('shellcheck inner script: skipped, not on PATH')

# Stub standing in for the Tizen CLI. Its outputs are copied from run
# 41846786550 (CLI 2.5.25) rather than invented, including the advice line
# `add` prints at the end — which recommends the OTHER key spelling than the
# one the reference docs name, and is the reason the step reads both.
TIZEN = r"""#!/usr/bin/env bash
set -u
state="$TIZEN_STUB_STATE"
case "$1 ${2:-} ${3:-}" in
  "cli-config -l "*)
    cat "$TIZEN_STUB_CLICONFIG"
    ;;
  "cli-config "*=*)
    # Recorded whole: which key the step writes is part of what is under
    # test, so the stub must not quietly accept any spelling as the same
    # thing. -l has no "=" and is matched above.
    printf '%s\n' "$2" > "$state/write"
    if [ -n "${TIZEN_STUB_WRITE_RC:-}" ]; then
      echo "Invalid key: ${2%%=*}" >&2
      exit "$TIZEN_STUB_WRITE_RC"
    fi
    printf '%s\n' "${2#*=}" > "$state/path"
    echo "Setting configuration is succeeded...."
    ;;
  "security-profiles add"*)
    shift
    printf '%s\n' "$*" > "$state/addargs"
    force=no
    name=
    author= authorpw= dist= distpw=
    while [ $# -gt 0 ]; do
      case "$1" in
        -f) force=yes ;;
        -A) : ;;
        -n) name="$2"; shift ;;
        -a) author="$2"; shift ;;
        -p) authorpw="$2"; shift ;;
        -d) dist="$2"; shift ;;
        -dp) distpw="$2"; shift ;;
      esac
      shift
    done
    # Which certificate went in which slot, recorded by MEANING rather than
    # by argv order: swapping the author and distributor pairs is a real
    # mistake that produces a .wgt signed with the wrong key, and
    # verify-wgt.sh cannot see it because author-signature.xml is there
    # either way.
    printf 'author=%s\nauthorpw=%s\ndist=%s\ndistpw=%s\n' \
      "$author" "$authorpw" "$dist" "$distpw" > "$state/certs"
    if [ -n "$author" ] && [ "$author" = "$dist" ]; then
      echo "stub: the same file passed as author and distributor" >&2
      exit 2
    fi
    # Where the file goes when no key was written: the CLI knows its own
    # configuration, so it resolves the listing it would have printed. Not
    # an invented default — that would make the write-refused case pass for
    # the wrong reason.
    p="$(cat "$state/path" 2>/dev/null || true)"
    if [ -z "$p" ]; then
      p="$(sed -n "s/^[[:space:]]*default\.profiles\.path=//p" \
             "$TIZEN_STUB_CLICONFIG" | head -1)"
    fi
    [ -n "$p" ] || p="${TIZEN_HOME}-data/profile/profiles.xml"
    # The real failure, and the documented escape from it: without -f the
    # file must already be there, with -f the CLI makes it itself. It is NOT
    # assumed to create missing parent directories — nobody has measured
    # that, so the step keeps its own mkdir and this stub keeps it honest.
    if [ ! -f "$p" ]; then
      if [ ! -d "$(dirname "$p")" ]; then
        echo "stub: $(dirname "$p") does not exist; add -f is not assumed to create it" >&2
        exit 1
      fi
      if [ "$force" = yes ]; then
        printf '%s\n' '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' \
                      '<profiles active="" version="3.1"/>' > "$p"
      else
        echo "Not found a file of security profiles. Please check specified path."
        exit 1
      fi
    fi
    printf '%s\n' "$name" >> "$state/profiles"
    echo "Wrote to $p."
    echo "Succeed to add $name profile."
    echo "If want to sign by this, add the file of security profiles in CLI configuration"
    echo "  like tizen cli-config \"profiles.path=$p\"."
    ;;
  "security-profiles list ")
    # The unscoped listing shows only the active profile, which is why the
    # step does not use it.
    echo "Cannot find the active profile."
    ;;
  "security-profiles list -n"*)
    want="$4"
    if grep -qxF -- "$want" "$state/profiles" 2>/dev/null; then
      echo "Name:        $want"
      # The knob applies HERE too: a CLI that reports a profile it found and
      # still exits non-zero is the case that would fail a good build.
      exit "${TIZEN_STUB_LIST_RC:-0}"
    fi
    echo "Cannot find the profile: $want"
    exit "${TIZEN_STUB_LIST_RC:-1}"
    ;;
  *) echo "stub: unhandled: $*" >&2; exit 2 ;;
esac
"""

# Each defect this suite exists to catch, as a substitution applied to a copy
# of the workflow, with the case that must go red for it. `--mutate` runs the
# whole suite once per entry and insists on exactly that — the suite proving
# that it bites, rather than a sentence in BUILD.md claiming it does. A
# substitution that no longer matches is an error, not a skip: the step has
# been reworked and these need rereading. Each entry is the name, the text to
# replace, what to replace it with, and the case that must then fail, with an
# optional fifth element naming a tool the entry needs on PATH.
MUTATIONS = [
    ('nof', 'add -f -A \\', 'add -A \\',
     'no answer from the CLI'),
    ('noA', 'add -f -A \\', 'add -f \\',
     'add is given both -f and -A'),
    ('readorder',
     'profiles="$(cli_config_value "default\\.profiles\\.path")"',
     'profiles="$(cli_config_value "profiles\\.path")"',
     'both spellings, the bare one printed first'),
    ('barewrite', 'tizen cli-config "default.profiles.path=$profiles"',
     'tizen cli-config "profiles.path=$profiles"',
     'the write uses the documented key'),
    ('unguardedwrite',
     '|| echo "::warning::could not set default.profiles.path',
     '|| false # ',
     'the CLI refuses the key on the write'),
    ('wrongfallback', ': "${profiles:=${TIZEN_HOME}-data/profile/profiles.xml}"',
     ': "${profiles:=$HOME/tizen-studio-data/profile/profiles.xml}"',
     'no answer from the CLI'),
    ('notrim', '-e "s/^[[:space:]]*//" -e "s/[[:space:]]*$//"',
     '-e "s/^[[:space:]]*//"',
     'a carriage return and trailing spaces on the path'),
    ('noleadtrim', '-e "s/^[[:space:]]*//" -e "s/[[:space:]]*$//"',
     '-e "s/[[:space:]]*$//"',
     'leading as well as trailing whitespace around the path'),
    ('unescapedsed',
     'profiles="$(cli_config_value "default\\.profiles\\.path")"',
     'profiles="$(cli_config_value "default.profiles.path")"',
     'a key an unescaped dot would match'),
    ('nomkdir', '            mkdir -p "$(dirname "$profiles")"\n', '',
     "the CLI's answer wins over the fallback"),
    ('swappedcerts',
     '-a "$CERTS/author.p12" -p "$AUTHOR_PASSWORD" \\\n'
     '              -d "$CERTS/distributor.p12" -dp "$DISTRIBUTOR_PASSWORD"',
     '-a "$CERTS/distributor.p12" -p "$DISTRIBUTOR_PASSWORD" \\\n'
     '              -d "$CERTS/author.p12" -dp "$AUTHOR_PASSWORD"',
     'each certificate and password reaches its own slot'),
    ('swappedpasswords',
     '-a "$CERTS/author.p12" -p "$AUTHOR_PASSWORD"',
     '-a "$CERTS/author.p12" -p "$DISTRIBUTOR_PASSWORD"',
     'each certificate and password reaches its own slot'),
    ('nobareread',
     '            if [ -z "$profiles" ]; then\n'
     '              profiles="$(cli_config_value "profiles\\.path")"\n'
     '            fi\n', '',
     'the bare spelling on its own is still used'),
    ('unanchoredsed', 'sed -n "s/^[[:space:]]*$1=//p"',
     'sed -n "s/^$1=//p"',
     'cli-config -l indents its output'),
    # The defect is the UNGUARDED capture under errexit, which is what a
    # perfectly ordinary refactor of that line produces. `if true; then` is
    # only scaffolding to keep the rest of the block parsing; writing the
    # idiomatic bare `list -n` instead turns the same two cases red with the
    # same diagnosis.
    ('ungatedlist',
     'if listed="$(tizen security-profiles list -n "$CERT_PROFILE" 2>&1)"; then',
     'listed="$(tizen security-profiles list -n "$CERT_PROFILE" 2>&1)"\n'
     '            if true; then',
     'list -n exits non-zero although the profile is there'),
    ('ignorecliconfig',
     'profiles="$(cli_config_value "default\\.profiles\\.path")"',
     'profiles=""',
     "the CLI's answer wins over the fallback"),
    # These two are caught before any case runs, so what is expected is the
    # message the run dies with rather than a case name.
    ('apostrophe', '# `|| true` on the pipeline',
     '# the pipeline\'s `|| true`',
     'apostrophe inside the single-quoted bash -c block'),
    ('unquoted', '            printf "profiles file: %s\\n" "$profiles"',
     '            printf "profiles file: %s\\n" "$profiles"\n'
     '            ls -d $profiles || true',
     'shellcheck is not clean', 'shellcheck'),
]


def mutate():
    """Run the whole suite against one defective copy of the workflow each."""
    raw = SRC.read_text()
    bad = []
    ran = skipped = 0
    for entry in MUTATIONS:
        # A fifth element names a tool the entry cannot run without.
        name, old, new, expected = entry[:4]
        needs = entry[4] if len(entry) > 4 else None
        if needs and not shutil.which(needs):
            print(f'skip   {name} -> needs {needs} on PATH')
            skipped += 1
            continue
        if raw.count(old) != 1:
            bad.append(f'{name}: the workflow no longer contains its target '
                       f'exactly once ({raw.count(old)} matches)')
            print(f'BROKEN {name}')
            continue
        ran += 1
        tmp = pathlib.Path(tempfile.mkdtemp()) / SRC.name
        tmp.write_text(raw.replace(old, new))
        r = subprocess.run([sys.executable, SELF, str(tmp)],
                           capture_output=True, text=True)
        out = r.stdout + r.stderr
        # `FAIL  <case>`, not `<case>`: the suite prints the name of every
        # case it runs, `ok` ones included, so matching the bare name only
        # asks whether the case exists. The two defects caught before any
        # case runs are matched on the message the run dies with instead.
        ok = r.returncode != 0 and ('FAIL  ' + expected in out
                                    or 'signtest.py: ' + expected in out)
        if not ok:
            bad.append(f'{name}: rc={r.returncode}, expected {expected!r}')
        print(('ok     ' if ok else 'LIVED  ') + f'{name} -> {expected}')
        shutil.rmtree(tmp.parent, ignore_errors=True)
    tail = f' ({skipped} skipped)' if skipped else ''
    print('\n' + ('SURVIVING MUTANTS:\n  ' + '\n  '.join(bad) if bad
                  else f'all {ran} mutations killed' + tail))
    raise SystemExit(1 if bad else 0)


fails = []


def run(case, cli_config_out, expect_rc=0, expect=(), reject=(),
        list_rc=None, wipe_profiles=False, write_rc=None):
    work = pathlib.Path(tempfile.mkdtemp())
    bin_ = work / 'bin'
    bin_.mkdir()
    state = work / 'state'
    state.mkdir()
    (state / 'profiles').touch()
    (bin_ / 'tizen').write_text(TIZEN)
    (bin_ / 'tizen').chmod(0o755)
    for stub, body in (
        ('gnome-keyring-daemon', '#!/bin/sh\nexit 0\n'),
        ('dbus-run-session', '#!/bin/sh\nshift\nexec "$@"\n'),
    ):
        (bin_ / stub).write_text(body)
        (bin_ / stub).chmod(0o755)
    cfg = work / 'cliconfig.txt'
    cfg.write_text(cli_config_out.replace('{work}', str(work)))
    (work / 'scripts').mkdir()
    build = work / 'scripts/build-wgt.sh'
    build.write_text('#!/bin/sh\necho "build-wgt.sh ran with profile $1"\n')
    build.chmod(0o755)
    gh_env = work / 'gh_env'
    gh_env.touch()

    if wipe_profiles:
        # `add` succeeds, but nothing lands in the listing.
        (bin_ / 'tizen').write_text(
            TIZEN.replace('printf \'%s\\n\' "$name" >> "$state/profiles"', ':'))
        (bin_ / 'tizen').chmod(0o755)

    try:
        r = subprocess.run(
            ['bash', '-euo', 'pipefail', '-c', inner],
            cwd=work, capture_output=True, text=True,
            env={'PATH': f'{bin_}:{os.environ["PATH"]}', 'HOME': str(work),
                 'TIZEN_HOME': str(work / '.tizen-studio'),
                 'CERT_PROFILE': 'digmi-ci', 'CERTS': str(work / 'certs'),
                 # Deliberately different: equal passwords would hide a swap
                 # of the two.
                 'AUTHOR_PASSWORD': 'author-pw',
                 'DISTRIBUTOR_PASSWORD': 'dist-pw',
                 'GITHUB_ENV': str(gh_env), 'TIZEN_STUB_STATE': str(state),
                 **({'TIZEN_STUB_LIST_RC': list_rc} if list_rc else {}),
                 **({'TIZEN_STUB_WRITE_RC': write_rc} if write_rc else {}),
                 'TIZEN_STUB_CLICONFIG': str(cfg)},
        )
        log = r.stdout + r.stderr + '\n--- $GITHUB_ENV ---\n' + gh_env.read_text()
        for name in ('write', 'addargs', 'certs'):
            f = state / name
            log += f'\n--- {name} ---\n' + (f.read_text() if f.exists() else '')
        bad = []
        if r.returncode != expect_rc:
            bad.append(f'rc {r.returncode}, expected {expect_rc}')
        for want in [w.replace('{work}', str(work)) for w in expect]:
            if want not in log:
                bad.append(f'missing {want!r}')
        for nope in [n.replace('{work}', str(work)) for n in reject]:
            if nope in log:
                bad.append(f'unexpected {nope!r}')
        print(('FAIL  ' if bad else 'ok    ') + case
              + (f'   {bad}' if bad else ''))
        if bad:
            fails.append(case)
            print(re.sub(r'^', '        ', log, flags=re.M))
    finally:
        shutil.rmtree(work, ignore_errors=True)


if MUTATE:
    mutate()


# the CLI's answer must be the one used, not the fallback
run("the CLI's answer wins over the fallback",
    'default.profiles.path={work}/elsewhere/profile/profiles.xml\n', expect_rc=0,
    expect=['profiles file: {work}/elsewhere/profile/profiles.xml',
            'PROFILES_FILE={work}/elsewhere/profile/profiles.xml',
            'build-wgt.sh ran with profile digmi-ci'],
    reject=['Not found a file of security profiles'])

run('no answer from the CLI — the measured fallback',
    'some.other.key=1\n', expect_rc=0,
    expect=['profiles file: {work}/.tizen-studio-data/profile/profiles.xml\n',
            'Name:        digmi-ci', 'build-wgt.sh ran with profile digmi-ci'],
    # without the dot: $HOME/tizen-studio-data, the path that never existed
    # on the runner. The suite was green against that bug until the review
    # that found it, because $HOME is the work directory here and the two
    # paths differ by a single character.
    reject=['Not found a file of security profiles',
            '{work}/tizen-studio-data/profile'])

run('cli-config -l says nothing at all',
    '', expect_rc=0,
    expect=['profiles file: {work}/.tizen-studio-data/profile/profiles.xml\n',
            'build-wgt.sh ran with profile digmi-ci'],
    reject=['{work}/tizen-studio-data/profile'])

# Tolerated, not preferred: read only because nothing documented was listed.
# No runner has been seen to list it — 41846786550's listing was
# `default.`-prefixed throughout — but the CLI itself recommends this spelling
# in the advice line the stub above reproduces.
run('the bare spelling on its own is still used',
    'profiles.path={work}/unprefixed/profile/profiles.xml\n', expect_rc=0,
    expect=['profiles file: {work}/unprefixed/profile/profiles.xml'])

# The finding on PR #6, with the premise corrected afterwards: the key is
# documented as `default.profiles.path` in full, so THAT is the one that wins,
# and `head -1` over a single pattern matching both picked by position.
# `documented` and `bare` below are the two spellings, not two authorities.
run('both spellings, the bare one printed first',
    'profiles.path={work}/bare/profile/profiles.xml\n'
    'default.profiles.path={work}/documented/profile/profiles.xml\n',
    expect_rc=0,
    expect=['profiles file: {work}/documented/profile/profiles.xml\n',
            'PROFILES_FILE={work}/documented/profile/profiles.xml\n'],
    reject=['profiles file: {work}/bare', 'PROFILES_FILE={work}/bare'])

run('both spellings, the documented one printed first',
    'default.profiles.path={work}/documented/profile/profiles.xml\n'
    'profiles.path={work}/bare/profile/profiles.xml\n',
    expect_rc=0,
    expect=['profiles file: {work}/documented/profile/profiles.xml\n'],
    reject=['profiles file: {work}/bare', 'PROFILES_FILE={work}/bare'])

# The step must write the key Samsung documents, not the bare spelling it
# wrote until 2026-11-04. Without this the suite would not notice the write
# going back, because nothing downstream of it is load-bearing.
run('the write uses the documented key',
    'default.profiles.path={work}/documented/profile/profiles.xml\n',
    expect_rc=0,
    expect=['--- write ---\ndefault.profiles.path='
            '{work}/documented/profile/profiles.xml'])

# Both options exist on the binary: `security-profiles add --help` in run
# 41846786550 lists `-f (--force)  If there is no Profile XML, then generates
# a file.` and `-A (--active)  Set this profile as active.`
run('add is given both -f and -A',
    'default.profiles.path={work}/p/profiles.xml\n',
    expect_rc=0,
    # The recorded argv, not `-f` loose in the log: two characters matched
    # against the whole transcript would be masked by any future line
    # containing them.
    expect=['--- addargs ---\nadd -f -A -n digmi-ci '])

# Which certificate and which password land in which slot. Swapping the author
# and distributor pairs signs the package with the wrong key, and nothing
# downstream notices: verify-wgt.sh finds an author-signature.xml either way.
# Asserted on the stub record rather than on argv, so reordering the flags is
# allowed and reconnecting them is not.
run('each certificate and password reaches its own slot',
    'default.profiles.path={work}/p/profiles.xml\n',
    expect_rc=0,
    expect=['--- certs ---\n'
            'author={work}/certs/author.p12\n'
            'authorpw=author-pw\n'
            'dist={work}/certs/distributor.p12\n'
            'distpw=dist-pw\n'])

# MINOR 7 from review: `$1` is spliced into a sed BRE, and the step escapes the
# dots for that reason. Unescaped, `default.profiles.path` also matches a key
# spelled with any character in those positions — so a listing that holds only
# such a key must fall through to the fallback, not adopt its value.
run('a key an unescaped dot would match is not mistaken for ours',
    'defaultXprofilesXpath={work}/dotwild/profile/profiles.xml\n',
    expect_rc=0,
    expect=['profiles file: {work}/.tizen-studio-data/profile/profiles.xml\n'],
    # The decision lines, not the path: the step prints the whole listing by
    # design, so the raw path is in the log either way.
    reject=['profiles file: {work}/dotwild', 'PROFILES_FILE={work}/dotwild'])

run('leading as well as trailing whitespace around the path',
    'default.profiles.path=   {work}/lead/profile/profiles.xml   \n',
    expect_rc=0,
    expect=['profiles file: {work}/lead/profile/profiles.xml\n'],
    reject=['mkdir: ', 'profiles file:  '])

run('cli-config -l indents its output',
    '  default.profiles.path={work}/indented/profile/profiles.xml\n',
    expect_rc=0,
    expect=['profiles file: {work}/indented/profile/profiles.xml'])

run('a carriage return and trailing spaces on the path',
    'default.profiles.path={work}/crlf/profile/profiles.xml  \r\n',
    expect_rc=0,
    expect=['profiles file: {work}/crlf/profile/profiles.xml\n',
            'PROFILES_FILE={work}/crlf/profile/profiles.xml\n'])

run('a listing header rather than a key=value line',
    'Tizen CLI configuration\n====\n', expect_rc=0,
    expect=['profiles file: {work}/.tizen-studio-data/profile/profiles.xml\n'],
    reject=['{work}/tizen-studio-data/profile'])

# `security-profiles list -n` exits 0 for a profile that IS there: measured in
# run 41846786550, where no warning was emitted and the profile was present.
# This case is the opposite, kept because the gate must never fail a build
# that would have signed: a CLI version that answers non-zero anyway warns and
# carries on.
run('list -n exits non-zero although the profile is there',
    'default.profiles.path={work}/p/profiles.xml\n', expect_rc=0,
    list_rc='3',
    expect=['Name:        digmi-ci', '::warning::could not confirm',
            'build-wgt.sh ran with profile digmi-ci'])

# The documented key is accepted by CLI 2.5.25 — no warning fired in run
# 41846786550 — but unguarded under errexit a CLI that refused it would kill
# the step before `add`. It must warn and carry on, because the write's EFFECT
# is optional: `add -f` resolves the path itself.
run('the CLI refuses the key on the write',
    'default.profiles.path={work}/p/profiles.xml\n',
    expect_rc=0, write_rc='1',
    expect=['Invalid key: default.profiles.path',
            '::warning::could not set default.profiles.path',
            'build-wgt.sh ran with profile digmi-ci'])

# It warns and builds on: an unsigned package is stopped by verify-wgt.sh,
# not here. What matters is that the warning is in the log.
run('the profile really is missing after add',
    'default.profiles.path={work}/p/profiles.xml\n', expect_rc=0,
    wipe_profiles=True,
    expect=['Cannot find the profile', '::warning::could not confirm'])

print('\n' + ('FAILURES: ' + ', '.join(fails) if fails else 'all green'))
raise SystemExit(1 if fails else 0)
