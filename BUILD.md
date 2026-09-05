# Building and rolling out DigmiMarketing

Until 1.0.10 this repository held only built `.wgt` packages. The source now
lives in `src/`, so a change like "cap the retry backoff" is a diff instead of
an unzip. `src/` is the source of truth; the `.wgt` files under `production/`
and `staging/` are build output.

## What the TVs actually run

Samsung signage panels pull the widget over SSSP. The TV reads
`sssp_config.xml`, compares `<ver>` against what it has installed, and
downloads the `.wgt` beside it when the version is newer.

`production/latest/` is what the fleet follows. Note it shipped **1.0.7** while
`production/1.0.9/` sat unreleased next to it — check `latest/sssp_config.xml`
before assuming the newest directory is the deployed one.

## Packaging

Needs Tizen Studio; there is no CLI-only path. The signing profile is `TV`
(`~/tizen-studio-data/profile/profiles.xml`), backed by
`~/SamsungCertificate/TV/author.p12` and `distributor.p12`.

```sh
tizen build-web -- src
tizen package -t wgt -s TV -- src/.buildResult
```

**Sign with the same author certificate as the installed build.** Tizen refuses
an update signed by a different author, and recovering means uninstalling the
app on every panel by hand — the same trap as swapping an APK's signing key.

## Releasing

1. Bump `version` in `src/config.xml` and `appVersion` in `src/js/main.js`.
   They must match; the panel shows `appVersion` and that is what an engineer
   on site reads back.
2. Build and sign.
3. Drop the `.wgt` plus a `sssp_config.xml` carrying the new `<ver>` into
   `production/<version>/`.
4. Update `production/latest/` to the same pair. **This is the step that
   actually rolls out** — the fleet follows `latest/`, not the highest
   numbered directory.

## Reading a screen on site

The device panel (app version, model, tizenid, uuid, last API response, stage
geometry) is hidden by default. Press **INFO** or the **red** button on the TV
remote to toggle it. Before 1.0.10 there was no way to open it, so the QR code
was the only route to a device's uuid.
