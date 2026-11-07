#!/usr/bin/env bash
# Build and sign the lab probe.
#
# The clips are fetched at build time rather than committed: they are tens of
# megabytes of customer media and have no business in git history. They are
# PACKAGED rather than streamed because Samsung's own seamless sample plays
# local files — streaming would put network time inside the measurement and
# make UNIFORM-vs-MIXED a comparison of two variables at once.
#
#   ./build.sh                 build and sign
#   ./build.sh install         ...and install on the bench panel
#
# Needs a signing profile registered once, with the certificate password,
# which only Conny can do:
#
#   ~/tizen-studio/tools/ide/bin/tizen security-profiles add -n <profile> \
#     -a ~/SamsungCertificate/<profile>/author.p12 -p '<pw>' \
#     -d ~/SamsungCertificate/<profile>/distributor.p12 -dp '<pw>'
#
# Generic on purpose. Nothing here is a secret, but this file's own rule
# below is that a name reaching a commit counts as disclosed, and a public
# repo should not need the reader to decide which names that covers.
set -euo pipefail

# Before anything else: `./build.sh instal` used to fetch the clips, build
# four posters, package and sign, and only then say it did not know the word
# — a two-minute wrong answer where a one-second one was available.
case "${1:-}" in
  "" | install) ;;
  *)
    echo "unknown argument: $1 (expected nothing, or 'install')" >&2
    exit 1
    ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
TIZEN="${TIZEN:-$HOME/tizen-studio/tools/ide/bin/tizen}"
# The name as `tizen security-profiles list` prints it. A name that does not
# exist does NOT fail the package step: it produces an unsigned .wgt, and the
# panel then refuses it with "Check certificate error" twenty seconds later.
PROFILE="${PROFILE:-Digmi_Samsung_Partner_2026}"
SDB="${SDB:-$HOME/tizen-studio/tools/sdb}"
# Checked at use rather than at parse (a plain build needs no sdb), but checked
# BEFORE the first probe: a missing binary makes run_bounded return 127 and
# probe_alive then reports "sdb refused <addr>", which blames a panel that is
# perfectly fine. Two sdb clients exist on this machine and only one works.
# Deliberately NOT a hardcoded address. The bench router hands out new leases
# and the panel has already moved once mid-session; a stale default fails as
# "problem to transfer package", which reads like a broken build rather than a
# wrong address. Resolved from the connected device at install time instead,
# and only then, so a plain build needs no panel at all.
TARGET="${TARGET:-}"
# The bucket and the object names are kept OUT of git: this repo is public and
# they point at real customer media. A name that reaches a commit is disclosed
# and has to be rotated — deleting the file does not help, the history keeps
# it and so does anyone who cloned in between.
# The remote object names are content hashes, so a cached file can prove it
# is the file its name claims. The cache persists across sessions and
# branches and nothing else re-checks it; for an instrument whose first
# principle is that its numbers are true, "the bytes are the bytes" is cheap.
verify_cached() {
  local file="$1" name="$2" want got
  if ! command -v shasum >/dev/null; then
    echo "  (shasum missing — $name not verified against its name)" >&2
    return 0
  fi
  want="${name%%.*}"
  # EXACTLY 40 lowercase hex. "two hex then anything" matched any name
  # starting with two hex characters — ad*, be*, cafe*, dec*, face* — and
  # then stopped the build over a file that was fine, blaming its bytes. A
  # false stop is not a truth hazard, but a message that misnames the cause
  # is the thing being removed. (Deliberately no example filenames: the rule
  # at the top of this file says a name in a commit counts as disclosed, and
  # that rule should not need the reader to judge which names are invented.)
  case "${#want}" in
    40) ;;
    *)
      echo "  ($name is not a content hash — not verified)" >&2
      return 0
      ;;
  esac
  case "$want" in
    *[!0-9a-f]*)
      echo "  ($name is not a content hash — not verified)" >&2
      return 0
      ;;
  esac
  got="$(shasum -a 1 "$file" | cut -d' ' -f1)"
  # An unreadable file leaves got empty under pipefail, and "bytes are " read
  # as a content mismatch. The purpose is "the bytes are the bytes"; "the
  # bytes are nothing" is a different sentence and has to say so.
  if [ -z "$got" ]; then
    echo "shasum could not read $file" >&2
    return 1
  fi
  [ "$got" = "$want" ] || {
    echo "$file does not match the sha1 in its name:" >&2
    echo "  name says $want, bytes are $got — delete it and refetch" >&2
    return 1
  }
}

CLIPS_ENV="${CLIPS_ENV:-$HERE/clips.env}"
if [ ! -r "$CLIPS_ENV" ]; then
  echo "missing $CLIPS_ENV" >&2
  echo "cp clips.env.example clips.env and fill in the bucket and the object" >&2
  echo "names — they are deliberately not in git. See the comment there." >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$CLIPS_ENV"
[ -n "${BASE:-}" ] || {
  echo "$CLIPS_ENV sets no BASE" >&2
  exit 1
}
[ "${CLIPS+set}" = "set" ] && [ "${#CLIPS[@]}" -gt 0 ] || {
  echo "$CLIPS_ENV sets no CLIPS" >&2
  exit 1
}

STAGE="$(mktemp -d)"
# One handler, because `trap ... EXIT` REPLACES, it does not append. A second
# trap added later for the applist temp file silently discarded this one, and
# every install run then left the whole staged directory — three fetched
# clips, four posters and the signed .wgt — in /var/folders for good.
APPLIST=""
trap 'rm -rf "$STAGE"; rm -f "${APPLIST:-}" "${SSEOF_ERR:-}" "${ROT_ERR:-}"' EXIT
CACHE="$HERE/.media-cache"
mkdir -p "$CACHE" "$STAGE/media"

cp "$HERE/config.xml" "$HERE/index.html" "$HERE/icon.png" "$STAGE/"
mkdir -p "$STAGE/js" && cp "$HERE/js/main.js" "$STAGE/js/"

# The sink address goes into the STAGED copy only, so no bench address is ever
# committed. Left unset, the placeholder stays and the probe reads it as off.
#
# This exists because the panel gives nothing back: `sdb shell` runs but prints
# nothing, `dlogutil` returns no rows, and the on-screen log is a twelve-line
# window that two seams wipe. Posting the lines is the only way a run reaches
# another machine whole.
#
#   SINK=http://<this machine>:8777/log ./build.sh install
if [ -n "${SINK:-}" ]; then
  case "$SINK" in
    http://* | https://*) ;;
    *)
      echo "SINK must be an http(s) URL, got: $SINK" >&2
      exit 1
      ;;
  esac
  # The value lands inside a JS string literal: var SINK = "@SINK@";
  # A quote or a backslash in it does not fail loudly — it breaks the parse,
  # and the probe comes up as a white screen with no HUD at all, which reads
  # as a dead panel rather than as a bad argument.
  case "$SINK" in
    *[\"\\\`\ ]* | *[[:cntrl:]]*)
      echo "SINK must not contain a quote, backslash, backtick, space" >&2
      echo "or a control character — any of them break the JS string literal" >&2
      echo "and the probe then comes up as a blank screen with no HUD." >&2
      exit 1
      ;;
  esac
  # | as the delimiter, because the URL is full of slashes. Written to a new
  # file and moved, rather than sed -i, which differs between GNU and BSD.
  #
  # The replacement is escaped first. In a sed replacement an unescaped & is
  # the whole match, so a query string would put `@SINK@` back into the file:
  # the grep below catches it, but reports a placeholder that "survived"
  # rather than a URL that was mangled, and sends the reader somewhere else.
  sink_escaped=$(printf '%s' "$SINK" | sed 's/[&|\\]/\\&/g')
  sed "s|@SINK@|$sink_escaped|" "$STAGE/js/main.js" > "$STAGE/js/main.js.new"
  mv "$STAGE/js/main.js.new" "$STAGE/js/main.js"
  grep -q "@SINK@" "$STAGE/js/main.js" && {
    echo "the sink placeholder survived substitution" >&2
    exit 1
  }
  echo "log sink: $SINK"
  # The wire format, so a later bench session can read what it collected.
  # The sink tells the two apart by Content-Type: log batches are sent with
  # none (so they arrive as text/plain), an image is sent as
  # application/octet-stream. An image body is "IMG <filename>\n<base64>" —
  # strip the first line and pipe the rest through `base64 -d` for the JPEG.
fi

for row in "${CLIPS[@]}"; do
  local_name="${row%% *}"
  remote="${row##* }"
  # A local name with a slash or .. would cp outside $STAGE/media. The file
  # is author-written, but it is also the one place a typo reaches the
  # filesystem with a path in its hand.
  case "$local_name" in
    */* | *..* | "")
      echo "clips.env: '$local_name' is not a plain file name" >&2
      exit 1
      ;;
  esac
  if [ ! -s "$CACHE/$remote" ]; then
    echo "fetching $local_name ($remote)"
    curl -fsSL -o "$CACHE/$remote.part" "$BASE/$remote"
    mv "$CACHE/$remote.part" "$CACHE/$remote"
  fi
  verify_cached "$CACHE/$remote" "$remote" || exit 1
  cp "$CACHE/$remote" "$STAGE/media/$local_name"
done

# js/main.js plays u1.mp4, u2.mp4 and u3.mp4 by those exact local names. A
# clips.env with a typo, a renamed row or two rows instead of three otherwise
# produces a SIGNED, installable widget that plays nothing — or plays a short
# playlist while the HUD still labels it UNIFORM. Checked here, where the
# build can still be stopped.
for required in u1.mp4 u2.mp4 u3.mp4; do
  if [ ! -s "$STAGE/media/$required" ]; then
    echo "clips.env did not produce $required — js/main.js plays it by name" >&2
    echo "rows are: <local name> <remote object name>" >&2
    exit 1
  fi
done

# A poster per clip. The mask shows the OUTGOING clip's frame from
# PRE_MASK_SEC before its end — not the incoming clip's first frame, which is
# what this line used to say and what -sseof below exists to avoid. It covers
# the interval while AVPlay is torn down and rebuilt; for what that interval
# measures, and why the 826 ms GAP is not it, see the freezeMs/coverMs note
# in js/main.js. AVPlay draws BEHIND the page, so a DOM layer can
# cover it — measured on a
# QB43C, and the opposite of HTML5 video, which would have covered the mask.
if command -v ffmpeg >/dev/null; then
  # The frame the clip is showing AT THE MOMENT THE MASK GOES UP, which is
  # PRE_MASK_MS before the end — not the first frame, and not the very last
  # one either. The mask is raised early precisely because
  # onstreamcompleted fires too late, so the still has to match that earlier
  # instant: the true last frame would jump forward by PRE_MASK_MS, and
  # `-sseof -1` (what this used to be) jumped a whole second backwards, which
  # was visible on the bench as a rewind.
  #
  # Keep PRE_MASK_SEC in step with PRE_MASK_MS in js/main.js.
  PRE_MASK_SEC="${PRE_MASK_SEC:-0.4}"
  # PNG, not JPEG: JPEG stores colour at half resolution (4:2:0) and the
  # shift was visible on saturated material. And an explicit range
  # conversion, because video is BT.709 limited range (16-235) while the
  # browser paints sRGB full range — leave it implicit and a red turns
  # redder, which is exactly what the bench saw.
  # The fallback keeps -vf. Without it the still is painted in the wrong
  # range and a red turns redder — the very thing the paragraph above says
  # was visible on the bench — and the old fallback dropped it silently
  # while `posters: 3` still counted the file. It also loses -sseof, so it
  # IS the first frame the paragraph above rejects: say which clip got one,
  # on stderr, so the bench does not read that jump as an AVPlay failure.
  SSEOF_ERR="$(mktemp)"
  for f in "$STAGE"/media/*.mp4; do
    ffmpeg -nostdin -v error -y -sseof "-$PRE_MASK_SEC" -i "$f" -frames:v 1 \
      -vf "scale=in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709" \
      "${f%.mp4}-last.png" 2>"$SSEOF_ERR" ||
      {
        echo "$(basename "$f"): -sseof refused, poster is the FIRST frame" >&2
        # The reason, not just the fact: -sseof fails for a missing container
        # duration, a stream the demuxer cannot seek backwards in, and a
        # PRE_MASK_SEC longer than the clip — three different repairs.
        sed 's/^/    /' "$SSEOF_ERR" >&2 || true
        ffmpeg -nostdin -v error -y -i "$f" -frames:v 1 \
          -vf "scale=in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709" \
          "${f%.mp4}-last.png"
      }
  done
  echo "posters: $(ls "$STAGE"/media/*-last.png | wc -l | tr -d ' ')"

  # A still for the CAMPAIGN playlist, so the mixed run has one decoded
  # bitmap beside the two CSS cards. Taken from the middle of u3 rather than
  # from an end, so nobody mistakes it for a transition poster: it is
  # content, and it is the one item that proves a real image decodes and
  # scales the same way the video does.
  # The timestamp comes from the clip, not from a constant. `-ss 12` into a
  # clip shorter than 12 s produced NO file and exit 234, and the `|| echo`
  # kept the build green — and a missing still shows as a black card for
  # 6 s, because it is painted as a CSS background-image, which has no error
  # event. The bench would have read that as a decode failure.
  still_ss=0
  if command -v ffprobe >/dev/null; then
    still_dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 \
      "$STAGE/media/u3.mp4" 2>/dev/null || true)"
    still_ss="$(printf '%s' "${still_dur:-0}" | awk '{d=$1+0; printf "%d", (d>2) ? d/2 : 0}')"
  fi
  # PNG like the posters: the paragraph above rejects JPEG 4:2:0 for exactly
  # this material, and this still is content, so the argument covers it too.
  ffmpeg -nostdin -v error -y -ss "$still_ss" -i "$STAGE/media/u3.mp4" -frames:v 1 \
    -vf "scale=in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709" \
    "$STAGE/media/p1.png"
  if [ ! -s "$STAGE/media/p1.png" ]; then
    echo "campaign still p1.png is missing or empty after ffmpeg exited 0" >&2
    exit 1
  fi
  if [ "$still_ss" = "0" ]; then
    echo "campaign still: p1.png is u3.mp4's FIRST frame (no duration to" >&2
    echo "  halve) — it may read as a transition poster rather than content." >&2
  fi
  echo "campaign still: p1.png at ${still_ss}s of u3.mp4"
else
  echo "ffmpeg missing — no posters (the mask falls back to black) and no" >&2
  echo "  p1.png, so CAMPAIGN loses its one decoded bitmap as well." >&2
fi

echo "staged:"
ls -la "$STAGE/media"

# The comparison only means something if the control group is a control
# group. The names are sha1s of processed output and the fleet has had a
# re-transcode pass, so a comment claiming 1080x1920@25 proves nothing.
if ! command -v ffprobe >/dev/null; then
  if [ "${ALLOW_UNVERIFIED:-}" = "1" ]; then
    echo "ffprobe missing and ALLOW_UNVERIFIED=1 — the control group is NOT proven" >&2
  else
    echo "ffprobe missing: cannot prove the control group is uniform." >&2
    echo "brew install ffmpeg, or set ALLOW_UNVERIFIED=1 to build anyway." >&2
    exit 1
  fi
else
  echo "--- measured ---"
  ROT_ERR="$(mktemp)"
  sig=""
  for f in "$STAGE"/media/*.mp4; do
    raw="$(ffprobe -v error -select_streams v:0 \
      -show_entries stream=width,height,avg_frame_rate,bit_rate \
      -show_entries format=duration -of csv=p=0 "$f" | tr '\n' ' ')"
    # 25/1 and 2500/100 are the same rate written two ways; compare the value.
    # csv=p=0 puts the stream fields in ONE whitespace field, comma separated,
    # with the format duration after it. Split on the comma, not on spaces.
    fps="$(printf '%s' "$raw" | awk '{split($1,f,","); n=split(f[3],a,"/"); printf "%.3f", (n==2 && a[2]>0) ? a[1]/a[2] : 0}')"
    dims="$(printf '%s' "$raw" | awk '{split($1,f,","); print f[1]"x"f[2]}')"
    # width/height are always CODED geometry, so a clip carrying a 90 degree
    # display rotation reads identically to an unrotated one here while
    # DISPLAYING transposed. Without this the gate would call a rotated clip
    # part of a proven uniform group.
    # Not 2>/dev/null: an ffprobe old enough to reject the entry name exits
    # non-zero, and swallowing that kills the build mid-measurement with no
    # reason on screen. `|| true` would be worse — it would default rot=0 and
    # silently reopen the hole this check closes.
    # NOT piped into head: under pipefail a closed pipe reports failure on
    # success, which this file already paid twenty minutes for once. Captured
    # whole, then the first line taken by parameter expansion.
    #
    # Keyed on the EXIT CODE, not on whether stderr happened to be non-empty.
    # An ffprobe that fails while writing nothing at -v error would otherwise
    # leave rot_err empty, default rot to 0, and pass a rotated clip through
    # the gate — the exact hole the gate exists to close.
    rot_rc=0
    rot_all="$(ffprobe -v error -select_streams v:0 \
      -show_entries stream_side_data=rotation -of default=nw=1:nk=1 "$f" \
      2>"$ROT_ERR")" || rot_rc=$?
    rot="${rot_all%%
*}"
    if [ "$rot_rc" -ne 0 ]; then
      echo "ffprobe cannot read the display rotation (exit $rot_rc):" >&2
      sed 's/^/  /' "$ROT_ERR" >&2 || true
      echo "a rotated clip would pass the uniformity gate unnoticed." >&2
      exit 1
    fi
    rot="${rot:-0}"
    printf '%-8s %-12s %s fps  %s\n' "$(basename "$f")" "$dims" "$fps" "$raw"
    case "$(basename "$f")" in
      u*.mp4)
        line="$dims@$fps rot=$rot"
        if [ -z "$sig" ]; then
          sig="$line"
        elif [ "$line" != "$sig" ]; then
          echo "UNIFORM clips disagree: $line vs $sig — the control group is not one" >&2
          exit 1
        fi
        ;;
    esac
  done
  if [ -z "$sig" ]; then
    echo "no u*.mp4 reached the measurement — the control group is empty" >&2
    exit 1
  fi
  echo "uniform set: $sig"
fi

# `tizen build-web` crashes on this install with
# NoClassDefFoundError: org/eclipse/core/runtime/Plugin — it wants Eclipse
# runtime pieces the web-cli package does not carry. For a plain web widget
# it only copies and minifies anyway, so the staged directory is packaged
# directly. The .wgt is a zip of exactly these files either way.
"$TIZEN" package -t wgt -s "$PROFILE" -- "$STAGE"

# Signing is the step that fails silently, so check the product rather than
# the exit code: an unsigned widget looks like a successful build.
# `|| true`, because `set -euo pipefail` plus a glob that matches nothing
# kills the script on the `ls` BEFORE the message below can be printed — a
# packaging failure then exits 1 in total silence.
WGT_TMP="$(ls -t "$STAGE"/*.wgt 2>/dev/null | head -1 || true)"
[ -n "$WGT_TMP" ] || {
  echo "package produced no .wgt" >&2
  exit 1
}
# Listed once into a variable, never piped into `grep -q`: under pipefail a
# matching grep -q closes the pipe, unzip dies of SIGPIPE, and the pipeline
# reports failure on success. That cost twenty minutes once.
WGT_INDEX="$(unzip -l "$WGT_TMP")"
for sigfile in author-signature.xml signature1.xml; do
  case "$WGT_INDEX" in
    *"$sigfile"*) ;;
    *)
      echo "packaged WITHOUT $sigfile — profile '$PROFILE' did not sign it" >&2
      exit 1
      ;;
  esac
done
echo "signed: author-signature.xml + signature1.xml present"

# Exactly one package, or stop. `find -exec cp` exits 0 when it matches
# nothing, which would leave the PREVIOUS build in place and print a
# convincing hash for it — the same trap `64fb9dc` fixed in the release
# workflow ("promote the package the descriptor names, not the first one
# found").
OUT="$HERE/DigmiAvplayProbe.wgt"
rm -f "$OUT"
count="$(find "$STAGE" -maxdepth 1 -name '*.wgt' | wc -l | tr -d ' ')"
[ "$count" = 1 ] || { echo "expected exactly one .wgt, found $count" >&2; exit 1; }
cp "$(find "$STAGE" -maxdepth 1 -name '*.wgt')" "$OUT"
ls -la "$OUT"
shasum -a 256 "$OUT"

if [ "${1:-}" = "install" ]; then
  [ -x "$SDB" ] || {
    echo "sdb not found or not executable: $SDB" >&2
    echo "set SDB= to the one that works (tizen-studio/tools/sdb)." >&2
    exit 1
  }
  if [ -z "$TARGET" ]; then
    # Captured once, so the failure branch can SHOW what sdb said: "run
    # connect" and "the panel is there but offline" need different answers,
    # and a blind "no panel connected" covers both. `|| true` because under
    # `set -e` a non-zero sdb would kill the script before any message.
    DEVICES="$("$SDB" devices 2>&1 || true)"
    # `sdb devices` prints a version-mismatch banner and a header line as
    # well, so take rows whose state field is exactly `device`: `offline` is
    # a row too, and installing to one hangs.
    MATCHES="$(printf '%s\n' "$DEVICES" | awk '$2 == "device" { print $1 }')"
    COUNT="$(printf '%s' "$MATCHES" | grep -c . || true)"
    # Defaulted, because `|| true` can leave it empty and `[ "" -gt 1 ]` is a
    # non-integer error — under `set -e` that ends the script, and without it
    # two connected panels would read as one and the install would pick the
    # wrong device.
    COUNT="${COUNT:-0}"
    if [ "$COUNT" -gt 1 ]; then
      echo "more than one panel is connected — name the one you mean:" >&2
      printf '%s\n' "$MATCHES" | sed 's/^/  TARGET=/' >&2
      exit 1
    fi
    TARGET="$MATCHES"
  fi
  [ -n "$TARGET" ] || {
    echo "no panel in 'device' state. sdb reports:" >&2
    printf '%s\n' "${DEVICES:-<sdb produced no output>}" | sed 's/^/  /' >&2
    echo "connect it with '$SDB connect <ip>:26101', or set TARGET=<ip>:26101." >&2
    echo "the lease moves, so scan your own subnet for the open sdb port" >&2
    echo "rather than guessing an address." >&2
    exit 1
  }
  # An entry can read `device` long after the panel's lease moved: `sdb
  # devices` reports the stored connection, it does not probe it. Without
  # this, a stale entry fails ten minutes later as "problem to transfer
  # package" — which reads like a broken build, not a wrong address.
  #
  # Bounded, because the failure modes differ: a panel that sent FIN answers
  # instantly, but one that vanished without it (Wi-Fi pulled, power cut)
  # leaves the client in TCP retransmission for a minute and a half with
  # nothing on screen. `timeout` is not on this machine, hence the by-hand
  # wait. sdb does not propagate the remote command's exit code, so this is
  # purely a liveness test and does not depend on `true` existing on the panel.
  # Every sdb call on this path goes through the ceiling, not just the probe:
  # a reconnect to a vanished panel stalls exactly as long as a probe does,
  # so bounding only one of them moves the stall rather than removing it.
  run_bounded() {
    local limit="$1"
    shift
    local pid waited
    "$@" >/dev/null 2>&1 &
    pid=$!
    waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$limit" ]; do
      sleep 0.1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.3
      # SIGKILL after a short grace. A child that ignores TERM would leave
      # `wait` blocking for ever, which is the ceiling undone.
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      # 124, the convention `timeout` uses, so a caller can tell a ceiling
      # apart from a command that failed instantly. Collapsing the two let
      # "sdb is not where we think it is" print as "the panel gave no answer
      # within 10s" — three different states, one sentence, two of them false.
      return 124
    fi
    # NOTE: this propagates the child's own status, so a bare call would end
    # the script under `set -e`. Every call site below tests it.
    wait "$pid"
  }
  # run_bounded sends stdout to /dev/null, so `$(run_bounded ...)` captures
  # nothing — every branch that read it was dead and the answer was always
  # "unknown". Same ceiling, same 124, but the child writes to a file the
  # caller then reads. stderr still goes away: it is sdb's chatter, not an
  # answer.
  run_bounded_out() {
    local limit="$1" out="$2"
    shift 2
    local pid waited
    "$@" >"$out" 2>/dev/null &
    pid=$!
    waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$limit" ]; do
      sleep 0.1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.3
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    wait "$pid"
  }

  probe_alive() {
    local rc=0
    run_bounded 100 "$SDB" -s "$1" shell true || rc=$?
    if [ "$rc" -eq 0 ]; then
      return 0
    fi
    if [ "$rc" -eq 124 ]; then
      echo "  ($1 gave no answer within 10s)" >&2
    else
      # Not "it never reached $1": run_bounded discards sdb's output, so the
      # exit code is ALL we have, and the bench case this script was taught to
      # recover from is exactly one where the panel WAS reachable and sdb
      # refused it anyway. Report the observation, not the inference.
      echo "  (sdb refused $1, exit $rc)" >&2
    fi
    return 1
  }
  # Twice, because the state this catches is sometimes self-healing: a socket
  # in CLOSE_WAIT fails the first probe, after which sdb drops the entry and
  # a reconnect restores it. One shot would abort a FINISHED build over a
  # condition that clears itself in under a second.
  if ! probe_alive "$TARGET"; then
    echo "$TARGET did not answer — resetting the local sdb server." >&2
    # Measured on the bench, 2026-11-06: the panel was answering on 26101
    # (a bare TCP connect succeeded) while sdb refused it. `connect` alone
    # replied "already connected" and did nothing, and a disconnect followed
    # by connect then failed outright — the wedged state was in the LOCAL
    # sdb server, not the panel. Restarting the server fixed it immediately.
    # Hence the whole sequence rather than a bare reconnect.
    #
    # It also means an open 26101 does NOT prove the panel is usable, so the
    # port scan this script suggests is a way to find the address, not a
    # verdict on the connection.
    # No `disconnect` first: kill-server discards the whole connection table
    # anyway, and on a wedged server the disconnect can itself sit out the
    # ceiling. This DOES cost every other sdb connection on the machine —
    # other panels, and any `sdb dlog` tail mirroring a run — so say so
    # rather than taking them away silently.
    echo "  (this drops every sdb connection here, including any dlog tail)" >&2
    run_bounded 100 "$SDB" kill-server || true
    run_bounded 100 "$SDB" start-server || true
    sleep 1
    # With the port: stripping it would reconnect a non-default port to 26101
    # and then probe an address that was never the one asked for.
    run_bounded 100 "$SDB" connect "$TARGET" || true
    probe_alive "$TARGET" || {
      # Deliberately not "the lease has moved": the line above says which of
      # the two it was, and this one must not overwrite it with a guess.
      echo "$TARGET is listed but unusable — see the reason above." >&2
      echo "if the panel moved, find its current address and connect there." >&2
      exit 1
    }
  fi
  echo "installing on $TARGET"
  # Check the product, not the exit code — the same rule the packaging step
  # above applies for the same reason. The panel can reject a package and
  # the CLI still finish, and the last line printed was "installing", in the
  # present tense, BEFORE the attempt. The bench then reads the previous
  # build's numbers as the new build's, which is the one failure this whole
  # instrument is built to not have.
  "$TIZEN" install -n "$(basename "$OUT")" -s "$TARGET" -- "$HERE"
  # applist is asked through `sdb shell`, and this panel has been measured
  # answering `sdb shell` with NO OUTPUT AT ALL (see the note at the top of
  # this file, and the same observation twice in js/main.js). So an empty
  # answer here is the expected case, not a verdict: it is the channel being
  # mute, not the package being absent. Said plainly rather than dressed up
  # as a check that passed.
  APPLIST="$(mktemp)"
  applist_rc=0
  run_bounded_out 200 "$APPLIST" "$SDB" -s "$TARGET" shell 0 applist || applist_rc=$?
  # 124 is the ceiling, and it must not fall through into the branches below:
  # with no output it read as "this panel is mute", which blames firmware for
  # a timeout, and with PARTIAL output it read as "applist DID answer, so the
  # package is absent" and failed a build whose install had succeeded. That
  # second one asserts something it never established.
  # Only rc 0 may conclude anything. Branching on 124 alone left every OTHER
  # non-zero exit falling through — and sdb that writes some output and then
  # fails (a reset mid-command, which is the flakiness this script resets the
  # local server for) landed in the "real absence" branch and failed a build
  # whose install had succeeded. stderr is discarded here, so a non-zero rc is
  # all the evidence there is that the ANSWER is not an answer.
  if [ "$applist_rc" -ne 0 ]; then
    if [ "$applist_rc" -eq 124 ]; then
      echo "applist did not answer within the ceiling." >&2
    else
      echo "applist exited $applist_rc — whatever it wrote is not an answer." >&2
    fi
    echo "the package is NOT confirmed either way. Start the probe and read" >&2
    echo "the version in the capability panel." >&2
    exit 0
  fi
  installed="$(cat "$APPLIST")"
  case "$installed" in
    *DgmiLab001*)
      echo "installed on $TARGET (applist confirms it)"
      ;;
    "")
      # rc is 0 here, so applist ran and chose to say nothing — which is
      # what this panel has been measured doing. The attribution is earned
      # now; branching on 124 alone, it was an inference printed as fact.
      echo "install finished. applist ran and returned nothing, which is" >&2
      echo "what this panel does — so the package is NOT confirmed either" >&2
      echo "way. Start the probe and read the version in the capability" >&2
      echo "panel." >&2
      ;;
    *)
      echo "install finished but DgmiLab001 is not in applist on $TARGET." >&2
      echo "applist DID answer, so this is a real absence: the panel" >&2
      echo "rejected it, or it landed somewhere else." >&2
      exit 1
      ;;
  esac
fi
