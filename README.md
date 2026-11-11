# TizenMarketingWeb

This is a hosted Digmi Marketing webapp for Tizen url starter.

## Table Of Contents

* [Where published builds come from](#where-published-builds-come-from)
* [B2B re-signed packages for TBM](#b2b-re-signed-packages-for-tbm)
* [howto tizen](#howto-tizen)
  * [Howto sssp from usb](#howto-sssp-from-usb)
  * [Howto sssp from web](#howto-sssp-from-web)

## Where published builds come from

`production/` and `production/latest/` are both served to displays over SSSP and
are kept in step with each other. `staging/` is separate and is not built by CI.
Releases are built, signed and published by the **Release widget** workflow, and
rolled out to the fleet by **Promote release**, which copies an already-proven
version rather than rebuilding it — see [BUILD.md](BUILD.md).

Do not hand-edit a descriptor; the one exception is `<size>` in a `b2b/`
descriptor, derived with `wc -c` as that section says. The naming rules below
are necessary but not sufficient: `<ver>` has to be an **integer** that increases, or a display never
re-downloads, and `<size>`, where stated, has to be the package's exact byte
count. The descriptors already committed here say `<ver>1.0.7</ver>` and omit
`<size>` — that is the format the workflow exists to replace, not an example to
copy.

## B2B re-signed packages for TBM

`b2b/latest/` and `b2b/<version>/` hold the widget **re-signed by Samsung's
"B2B App Certificate Re-signing Tool"** (Seller Office → Tools). Every file
inside the package, and our author signature over them, is unchanged; only
`signature1.xml` is replaced — with `VD B2B Distributor Partner Signer`
(expires 2027-01-01), which is not bound to any DUID — and therefore the zip
size differs from the build. It is meant for
**Tizen Business Manager → Device Control → Startup Solution → Custom App (URL)**
pointed at `https://digmiorg.github.io/TizenMarketingWeb/b2b/latest/`, or for a
USB stick, without a Seller Office review.

**Proven on a panel on 2026-11-10.** TBM → Device Control → Startup Solution →
Custom App (URL) pointed at `b2b/latest/` installed this package on the bench
QB43C and it paired and played. The one failure on the way there was the
panel's own clock: with it wrong the panel reported *Unable to connect to
server* (the TLS certificate cannot be validated against a wrong date), and
correcting the clock in the panel's menu was the whole fix. The widget now
attempts to turn NTP on at start on every build, and shows the drift in the
INFO panel (`js/timeguard.js`); only a Partner-signed build (`b2b/`, the
bench) can actually apply it, and the store build's attempt is reported as
`NTP refused`. As of 2026-11-11 that code has run under node, not on a panel.
What remains unmeasured is what the panel does with a package whose
distributor certificate has expired (2027-01-01 for the re-signed one); see
BUILD.md.

**Only for panels with no `E1lTJzhcnm` package installed.** Tizen is expected
to bind the author-key check to the *package* id `E1lTJzhcnm` (that is its
package model; not yet measured on a panel), which every build of this widget
shares — the SSSP build (`E1lTJzhcnm.DigmiMarketing`, old key) **and the
Seller Office store build the fleet runs (`E1lTJzhcnm.DigmiSignage`, store
key)**. `b2b/` is signed with the Partner-2026 key, and a display refuses an
update signed with a different author key (see
`scripts/author-identity-gate.sh`). So a panel that already has either build
has to have it uninstalled before this package goes on, and once a panel is on
`b2b/` it cannot be moved back to `production/` or the store build the same
way. Whether TBM can do that uninstall remotely is not known yet.

Uninstalling also clears the widget's `localStorage`, where the device id
(`myUUID`) lives. On a panel whose id came from Tizen's own `tizenid` — the
normal case — the reinstalled widget reads the same id again and the pairing in
portal.digmi.eu is expected to survive (`tizenid` is a device id; that it is
unchanged after an uninstall is not yet measured — check on the first panel). A
panel that had to fall back to a generated id (no `tizenid`) gets a new one and
has to be paired again; plan for that before uninstalling. To tell the two
apart before you uninstall: open the INFO panel on the screen and compare its
**DUID** field (read from `tizenid` on every start) with the device id the
portal shows — equal is a strong indication the pairing survives, different
means re-pair. An indication, not a guarantee: `getUUID()` generates a new id
if the `tizenid` read fails on the first start after the reinstall, so check
the pairing in the portal after every reinstall and re-pair if needed.

This directory is NOT written by CI, and no workflow checks it: it is updated
by hand, once per release, and checked by hand. To publish a version, mirror
the `production/` flow (prove on one panel first, then widen):

1. Build with the profile the channel already serves —
   `scripts/build-wgt.sh Digmi_Samsung_Partner_2026` — upload
   `.build/out/DigmiMarketing.wgt` to the Samsung tool and commit **two
   files** to `b2b/<version>/` and nothing to `latest/` yet: the result as
   `DigmiMarketing.wgt`, and `.build/out/sssp_config.xml` with `<size>`
   replaced by `wc -c < b2b/<version>/DigmiMarketing.wgt`. `<ver>` stays the
   integer `build-wgt.sh` derived (1.0.13 → `10013`). Any other profile has
   another author key, and panels already on `b2b/` would refuse the update.
2. Point one panel at `b2b/<version>/` through TBM Custom App (URL) and watch
   it install and play. From the second version on, make that a panel that
   already runs `b2b/latest/`, so the *update* path is what gets proven.
3. Only then copy the same two files to `b2b/latest/`, descriptor included,
   and point the test panel back at `b2b/latest/`.

1.0.13 is the first publish and `latest/` was filled in the same commit as
`1.0.13/`, before any panel test, because no panel followed `b2b/latest/` yet.

Before each commit, by hand:

```sh
scripts/verify-wgt.sh b2b/<version>                      # descriptor vs package, every signature digest, certificates
scripts/author-identity-gate.sh b2b/<version>/DigmiMarketing.wgt b2b/latest    # verdict = exit status:
case $? in 2) echo 'DIFFERENT AUTHOR KEY - do not publish';; 1) echo 'b2b/latest is broken - fix it first';; esac
cmp b2b/latest/DigmiMarketing.wgt b2b/<version>/DigmiMarketing.wgt            # after step 3
scripts/verify-wgt.sh b2b/latest                        # after step 3: the copied descriptor too
```

and after each merge, that Pages serves the bytes you committed — only the
version directory after step 1, both after step 3:

```sh
scripts/check-served.sh https://digmiorg.github.io/TizenMarketingWeb/ <sssp-ver> DigmiMarketing b2b/<version>/DigmiMarketing.wgt b2b/<version>                # after step 1
scripts/check-served.sh https://digmiorg.github.io/TizenMarketingWeb/ <sssp-ver> DigmiMarketing b2b/<version>/DigmiMarketing.wgt b2b/latest b2b/<version>     # after step 3
```

`<sssp-ver>` is the integer from the descriptor (`10013` for 1.0.13), not the
semver: with `1.0.13` the script polls until it times out and then reports
the served package as 'not this package'.


A re-sign of an already published version cannot be rolled out: `<ver>` comes
from the semver, so displays would not download it again. A new distributor
certificate (after 2027-01-01) therefore needs a version bump;
`verify-wgt.sh` warns 90 and 30 days ahead.

Why it exists: on 2026-11-10 a clean QB43C refused the Seller Office version
pushed by TBM as *Custom App (ID)* ("Unable to install the app"), and the
store's author certificate had expired on 2025-05-06. This channel depends on
neither. Anyone can download it and install it on a Samsung B2B panel. The
package carries the shared tablet bearer for `/api/v1/devices` in `main.js`,
as `production/`, the store build and every Digmi app do — nothing new is
exposed here — and a panel shows nothing until it is paired in
portal.digmi.eu, which is the same exposure `production/` already has.

## howto tizen

sssp\_config <widgetname> much match wgt file name

sssp\_config <widgetname> much match app config.xml name

sssp\_config <widgetname> much match app config.xml  \<tizen:application id={id.widgetname}>

example appName = MyApp

sssp\_config.xml

wgt filename MyApp.wgt

```xml
<widgetname>MyApp</widgetname>
```

app config.xml

```xml
<tizen:application id="{packageId}.MyApp" package="{packageId}" required_version="4.0"/>
<name>MyApp</name>
```

### Howto sssp from usb

* howto usb
  * create a folde ron usb stick named SSSP
    * copy sssp\_config.xml to SSSP folder
    * copy .wgt foldfileer to SSSP folder

### Howto sssp from web

put sspp\_config.xml and .wgt file on same directory
