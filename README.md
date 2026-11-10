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

Do not hand-edit a `production/` descriptor. The naming rules below are
necessary but not sufficient: `<ver>` has to be an **integer** that increases, or a display never
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

This directory is NOT written by CI. To publish a version, mirror the
`production/` flow (prove on one panel first, then widen):

1. Upload the `scripts/build-wgt.sh` output (`.build/out/DigmiMarketing.wgt`)
   to the Samsung tool and commit the result as `b2b/<version>/DigmiMarketing.wgt`
   only, with `.build/out/sssp_config.xml` copied next to it and `<size>` set
   to the re-signed file's byte count. `<ver>` stays the integer
   `build-wgt.sh` derived (1.0.13 → `10013`); `<widgetname>` must equal
   config.xml `<name>` and the .wgt file name (`verify-wgt.sh` checks the
   former, the display needs the latter).
2. Point one panel at `b2b/<version>/` through TBM Custom App (URL) and watch
   it install and play.
3. Only then copy the same two files to `b2b/latest/`.

1.0.13 is the first publish and `latest/` was filled in the same commit as
`1.0.13/`, before any panel test, because no panel followed `b2b/latest/` yet.
From the second version on, the order above applies.

Check by hand before each commit — no workflow does it for this directory:

```sh
scripts/verify-wgt.sh b2b/<version>                     # descriptor vs package
scripts/served-baseline.sh b2b/latest                   # <ver> to beat
scripts/author-identity-gate.sh b2b/<version>/DigmiMarketing.wgt b2b/latest   # same author key as already served
cmp b2b/latest/DigmiMarketing.wgt b2b/<version>/DigmiMarketing.wgt            # after step 3
```

and after each merge, that Pages serves the bytes you committed — only the
version directory after step 1 (`latest/` still advertises the old `<ver>` then,
and the script would wait on it and fail), both after step 3:

```sh
scripts/check-served.sh https://digmiorg.github.io/TizenMarketingWeb/ <ver> DigmiMarketing b2b/<version>/DigmiMarketing.wgt b2b/<version>                # after step 1
scripts/check-served.sh https://digmiorg.github.io/TizenMarketingWeb/ <ver> DigmiMarketing b2b/<version>/DigmiMarketing.wgt b2b/latest b2b/<version>     # after step 3
```

A re-sign of an already published version cannot be rolled out: `<ver>` comes
from the semver, so displays would not download it again. A new distributor
certificate (after 2027-01-01) therefore needs a version bump.

Why it exists: on 2026-11-10 a clean QB43C refused the Seller Office version
pushed by TBM as *Custom App (ID)* ("Unable to install the app"), and the
store's author certificate had expired on 2025-05-06. This channel depends on
neither. Anyone can download it and install it on a Samsung B2B panel; the
package holds nothing secret and a panel shows nothing until it is paired in
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
