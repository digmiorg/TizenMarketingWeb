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

Image requests 404 in this harness; those console errors are expected. Any
other console error is not.
