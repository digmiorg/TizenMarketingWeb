# checkdevice-probe

Drives `checkDevice()`'s polling lifecycle in a desktop browser with Tizen and
the portal stubbed out. It exists because the states that broke this function
are the ones a bench panel cannot be put into on demand: a rate-limited poll, an
unpairing, a re-pairing, and a campaign unplanned while the screen plays it.

Nothing here ships. `run.sh` builds a throwaway copy of `src/` in a temp
directory — `test.html` has to sit next to `js/` for the page's relative script
tags to resolve, and the widget must not carry a test page into a `.wgt`.

```sh
./lab/checkdevice-probe/run.sh          # serves on 8761
./lab/checkdevice-probe/run.sh 8762     # fresh port after editing main.js
```

Use a **fresh port** whenever `src/js/main.js` changed. The browser caches
per-origin, so the same port serves the previous build and the run silently
measures the old code.

## Driving it

Everything is on `window.__t`:

| field | meaning |
|---|---|
| `paired` | what `verify-device` answers in `device_exists` |
| `reason` | what the unpaired answer carries as `reason`. `null` leaves the key out entirely, which is the pre-#1649 payload |
| `fail` | `true` makes `verify-device` answer **429** with a JSON body |
| `media` | the `campaign_media` array `/api/v1/devices/{uuid}` returns |
| `verify`, `devices` | request counters per endpoint |
| `liveIntervals`, `maxLive` | live `setInterval` handles — `maxLive` is how orphaned rotation chains show up |
| `ticks` | total interval ticks |

`run.sh` keeps the playlist at 700 ms per item so a full loop — and therefore
`checkDeviceDataChanges()` — completes inside a run. Real durations are 10 s+,
so treat the request counts as relative, not as a traffic estimate.

## The phases worth re-running after any change to `checkDevice`

Each one is a bug that reached a customer or was caught in review.

1. **Campaign plays.** `regVisible` false, `mediaLength > 0`, status line empty,
   and `devices` must not climb with `verify` — a poll that re-fetches the
   playlist restarts the campaign from item 1 every 30 s.
2. **`fail = true` while playing.** The status line must stay **empty**. The chip
   is `position: fixed; z-index: 10000` over the video layer's `z-index: 10`, so
   anything written there sits on top of a paying customer's campaign — and no
   later poll clears it. The reason belongs in `#checkdevice-response`.
3. **`paired = false`.** The pairing view must come back, the container must be
   hidden and emptied, `window.rotationInterval` null, `window.displayMedia`
   null, `mediaLength` 0, `#media-playing-info` empty.
4. **`paired = true` again, several times over.** `maxLive` must not grow. Each
   cycle used to leak one immortal rotation chain, which then ticked against the
   previous playlist's length and threw a `TypeError` after blanking the stage.
5. **`media = []` while playing.** The playlist empties from inside
   `checkDeviceDataChanges()`, out of reach of anything in `checkDevice`. The
   screen must say nothing is planned **and** `checkDevice` must start fetching
   content again — a flag instead of a derived state left it silent forever,
   which is the Hair & Co state reached through its commonest door.
6. **`media = [...]` again.** Picked up with no reload.

6b. **`reason` through its values, with `paired = false`.** The activation view
   has two faces. The QR code belongs to `unknown`, to no `reason` at all, and
   to an empty string — `pairingWouldHelp()` treats anything that is not a
   definite other reason as "nobody has paired this", because a portal from
   before the field sends nothing and the QR was the whole behaviour.
   Every other non-empty *string* hides it — the branch is
   `typeof reason !== 'string'`, so a number, a boolean, `{}` or even a
   `String` object wrapping `'switched-off'` all show the QR code. Measured. Check the COMPUTED font size of
   `#reg-lead`, not just which face is up: removing the QR column from the landscape grid collapses `.digmi-copy`
   to ~60 px and drives the title to 7.5 px and the lead to 2.5 px, because
   `.digmi-copy` is a size container with no intrinsic width. That renders the
   message unreadable while every check on `display` and `textContent` still
   passes. Measured at 1920x1080; portrait is unaffected, so run landscape.
   Worth a pass each: `switched-off` and `suspended` (QR hidden), an empty
   string and `null` (QR shown), and the way back to `unknown`.

7. **The in-flight race.** Unpair while a `/api/v1/devices` request is in the
   air, then re-pair, and let the old request resolve. A stale rotation
   continuation must not touch the new chain. This is the one that froze a
   screen on slide 1 of 2 permanently and silently, and it is invisible to
   every other phase: `maxLive` stays at 3, no console error is raised, and
   `mediaLength` still reads 2. Watch `currentMediaIndex` over several slide
   durations instead — if it stops advancing, the chain is dead.

7b. **The same race, through the change branch.** Phase 7 only drives
   `checkDeviceDataChanges()`'s "nothing changed" path. Its *change* path is a
   separate hazard — it clears and nulls the rotation handle 27 lines above
   where it re-renders — and it is the one that runs in production:
   `MediaStorage.TTL` is 10 s while real slides are 10 s+, so the cache has
   almost always expired by the time the request resolves. To reach it, clear
   `localStorage` while the request is held, then release. A stale resolver
   must not touch the live chain.

Image requests 404 in this harness; those console errors are expected. Any
other console error is not — and phases 7 and 7b show that the absence of one
proves nothing. Neither does a green phase 7: these two differ only in whether
the cache is warm, and the first version of the guard passed 7 while leaving
7b broken.
