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

`b2b/latest/` and `b2b/<version>/` hold the same widget **re-signed by Samsung's
"B2B App Certificate Re-signing Tool"** (Seller Office → Tools). The tool keeps
our author signature and the package bytes untouched and replaces the
distributor signature with `VD B2B Distributor Partner Signer` (expires
2027-01-01), which is not bound to any DUID. It is meant for
**Tizen Business Manager → Device Control → Startup Solution → Custom App (URL)**
pointed at `https://digmiorg.github.io/TizenMarketingWeb/b2b/latest/`, or for a
USB stick, without a Seller Office review.

**Not yet proven on a panel.** The package has been verified on disk only
(content identical to the bench build, every digest valid, no DUID in the
certificate). The first TBM Custom App (URL) run against a panel is still to
be done; BUILD.md keeps the TBM/Seller Office path as unconfirmed until then.

**Only for panels without `DigmiMarketing` installed.** The app id is the same
as in `production/` (`E1lTJzhcnm.DigmiMarketing`) but the author key is not:
`production/` is signed with the old key, `b2b/` with the Partner-2026 key, and
a display refuses an update signed with a different author key (see
`scripts/author-identity-gate.sh`). A panel that already runs the production
build has to have the app uninstalled before this package goes on, and once a
panel is on `b2b/` it cannot be moved back to `production/` the same way.

This directory is NOT written by CI. To publish a version: upload the
`scripts/build-wgt.sh` output (`.build/out/DigmiMarketing.wgt`) to the Samsung
tool, commit the result as `b2b/<version>/DigmiMarketing.wgt` AND
`b2b/latest/DigmiMarketing.wgt`, and copy `.build/out/sssp_config.xml` next to
each with `<size>` changed to the re-signed file's byte count (the re-signing
changes the size; `<ver>` stays the integer `build-wgt.sh` derived, e.g. 1.0.13
→ `10013`, and `<widgetname>` stays the part of the app id after the dot). Then
check by hand — no workflow does it for this directory:

```sh
cmp b2b/latest/DigmiMarketing.wgt b2b/<version>/DigmiMarketing.wgt
scripts/verify-wgt.sh b2b/latest
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
