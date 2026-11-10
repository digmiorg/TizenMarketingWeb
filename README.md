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
`signature1.xml` is replaced — with `VD B2B Distributor Partner Signer` (expires
2027-01-01), which is not bound to any DUID — and therefore the zip size
differs from the build. It is meant for
**Tizen Business Manager → Device Control → Startup Solution → Custom App (URL)**
pointed at `https://digmiorg.github.io/TizenMarketingWeb/b2b/latest/`, or for a
USB stick, without a Seller Office review.

**Not yet proven on a panel.** The package has been verified on disk only
(content identical to the bench build, every digest valid, no DUID in the
certificate). The first TBM Custom App (URL) run against a panel is still to
be done; BUILD.md records the channel and what remains unconfirmed.

**Only for panels with no `E1lTJzhcnm` package installed.** Tizen is expected
to bind the author-key check to the *package* id `E1lTJzhcnm` (that is its
package model; not yet measured on a panel), which every build of this
widget shares — the SSSP build (`E1lTJzhcnm.DigmiMarketing`, old key) **and the
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

This directory is NOT written by CI. To publish a version, mirror the
`production/` flow (prove on one panel first, then widen):

1. Build with the profile the channel already serves —
   `scripts/build-wgt.sh Digmi_Samsung_Partner_2026` — upload
   `.build/out/DigmiMarketing.wgt` to the Samsung tool and commit **two
   files** to `b2b/<version>/` and nothing to `latest/` yet: the result as
   `DigmiMarketing.wgt`, and `.build/out/sssp_config.xml` with `<size>`
   replaced by `wc -c < b2b/<version>/DigmiMarketing.wgt`. Any other profile
   has another author key, and panels already on `b2b/` would refuse the
   update — `scripts/check-b2b.sh` (below, and in CI) compares the key with
   `b2b/latest/` and fails on a mismatch. `<ver>` stays the integer
   `build-wgt.sh` derived (1.0.13 → `10013`); `<widgetname>` must equal
   config.xml `<name>` and the .wgt file name — `check-b2b.sh` checks both,
   and a version directory without a descriptor fails outright.
2. Point one panel at `b2b/<version>/` through TBM Custom App (URL) and watch
   it install and play. From the second version on, make that a panel that
   already runs `b2b/latest/`, so the *update* path is what gets proven, not
   only a clean install; keep a clean panel for the install path when you
   have one.
3. Only then copy the same two files to `b2b/latest/`, descriptor included.
   Once Pages serves them, point the test panel back at `b2b/latest/` through
   TBM so it follows the fleet again (or keep a dedicated test panel on the
   version directory, if you have one to spare).

1.0.13 is the first publish and `latest/` was filled in the same commit as
`1.0.13/`, before any panel test, because no panel followed `b2b/latest/` yet.
From the second version on, the order above applies.

`scripts/check-b2b.sh` runs on every pull request and on pushes to `main`
that touch `b2b/` (the **Verify b2b** workflow): every directory has a
descriptor and passes `verify-wgt.sh`; the directory name, the package's `config.xml` version and `<ver>`
agree (`1.0.14` → `10014`); no two versions share a `<ver>`; every version
carries the author key `b2b/latest/` serves; and `b2b/latest/` is identical to
one of the version directories — behind the highest one is allowed and
reported (that is step 1), different from all of them is not, and identical
to a directory that failed makes `latest/` fail too. Against the base branch:
`latest/`'s `<ver>` never goes below what the base serves (a lower `<ver>` is
a silent freeze, not a rollback, because displays compare `<ver>` only), a
changed package under an unchanged `<ver>` is refused for the same reason, a
version directory the base already serves is immutable, and every directory —
`latest/` included — carries the author key the base's `latest/` carries (the
key the fleet runs). The three workflows that publish the Pages site run the same check and, if `b2b/`
on `main` fails it, publish the site **without the failing directories**
(`::error::` and a step-summary block in the run) rather than fail — Deploy
site is also the rollback path for `production/`, and a broken `b2b/` must
never stand between a revert and the panels. `latest/` is withheld only when
`latest/` itself is broken, so a bad new version directory never blanks the
fleet's path; and when the check itself cannot run (a tool missing on the
runner, an unexpected error) **all** of `b2b/` is withheld and the deploy still
goes on — an unchecked `b2b/` is never published, and `production/` is never
blocked. (The base-branch rules — `<ver>` not going backwards, `latest/`
keeping its author key — run only in **Verify b2b**, where a base exists; the
publish workflows have none, so a red PR is the line of defence there.)
Panels pointed at a withheld directory 404 on the descriptor
and are expected to keep what they have (documented SSSP behaviour, not yet
measured for TBM Custom App URL) until `b2b/` is fixed. Before the commit
also run:

```sh
scripts/check-b2b.sh b2b                                 # what CI will run
scripts/served-baseline.sh b2b/latest                    # <ver> the new one has to beat
```

`served-baseline.sh` reads the descriptor in the checkout, not Pages: on a
branch cut from `main` that is what Pages serves.

After each merge, check that Pages serves the bytes you committed — only the
version directory after step 1 (`latest/` still advertises the old `<ver>` then,
and the script would wait on it and fail), both after step 3:

```sh
scripts/check-served.sh https://digmiorg.github.io/TizenMarketingWeb/ <ver> DigmiMarketing b2b/<version>/DigmiMarketing.wgt b2b/<version>                # after step 1
scripts/check-served.sh https://digmiorg.github.io/TizenMarketingWeb/ <ver> DigmiMarketing b2b/<version>/DigmiMarketing.wgt b2b/latest b2b/<version>     # after step 3
```

A change of author key is never silent: with a base, every directory must
carry the key the base's `latest/` carries. The one sanctioned way to move
the channel to a new key is to commit the new key's sha256 (what
`scripts/author-identity.sh <wgt>` prints) as the first line of
`.github/b2b-accept-key`, and the key it replaces as the second line
(required as long as a directory on the old key remains), in the same pull
request — reviewed where it happens — and to plan the
consequence: every panel on the channel refuses the update until the app is
uninstalled on it (see above), so a rotation is a site visit per panel, not a
deploy. While the file names `latest/`'s key, the directories still on the one
older key are kept for the panels not yet re-pointed; once the base's
`latest/` carries the new key they may be removed. Remove them in the same
pull request as the accept file, or they fail from then on — and remove the
accept file once the leftovers are gone: a second rotation needs the first
one's leftovers removed first, since only one older key may remain.

A re-sign of an already published version cannot be rolled out: `<ver>` comes
from the semver, so displays would not download it again — and `check-b2b.sh`
refuses the attempt (changed bytes, unchanged `<ver>`). A new distributor
certificate (after 2027-01-01) therefore needs a version bump.

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
