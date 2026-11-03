# Building and releasing DigmiMarketing

The widget's source lives in `src/`. Everything under `production/` and
`staging/` is build output.

Releases go through the **Release widget** workflow, not a laptop. Before it
existed the package was built by hand in Tizen Studio, which is how
`production/latest/` came to serve 1.0.7 while 1.0.9 sat unreleased beside it —
the fleet follows `latest/`, so no screen ever saw it.

## How a display actually gets a new build

The URL configured on a display is **a directory on a web server**, not a web
page. The display fetches `sssp_config.xml` from it, compares `<ver>` with what
it has installed, and downloads the `.wgt` if that number grew.

Three details in that descriptor decide whether a release lands, and all three
have bitten this repository:

| Field | Rule | What a mistake looks like |
| --- | --- | --- |
| `<ver>` | an **integer**, must increase | nothing happens; the display never re-downloads |
| `<size>` | when stated, the exact byte count of the `.wgt` | the display fetches the descriptor and then declines the package |
| `<widgetname>` | identical to `<name>` in `config.xml` | install fails |

The package directory should hold **app files only**. The published 1.0.7
package carries `.gitignore`, `.gitattributes`, `Build/` and a nested
`tizen5.wgt`, and runs, so this is hygiene rather than a hard rule: a smaller
package, fewer signed files, and nothing in the artefact that nobody meant to
ship. Keep it anyway — a build that packages whatever happens to be in the
working tree is a build whose contents depend on who ran it.

The descriptors this repository currently serves omit `<size>` altogether. So
the element is evidently not mandatory, and we do not know whether its absence
is why `production/1.0.9` was never picked up — the other candidate is that
1.0.9 declares `required_version="5.0"` where the live 1.0.7 declares `4.0`.
Neither has been tested on a panel. Builds from this pipeline always state
`<size>`, which removes the question from any future release.

Pointing a display at a bare web page does not work. `<type>url</type>` in the
descriptor is silently ignored on current firmware; only a signed `.wgt` is
accepted.

### Two directories are served, not one

`production/latest/` and `production/` each hold a descriptor and a `.wgt`, and
today they hold the same package byte for byte. A screen's configured URL may
be either, and we cannot tell which from here — so the workflow writes both
whenever `publish_latest` is set. Updating only `latest/` would leave every
screen pointed at `production/` on `<ver>1.0.7`, permanently and invisibly.

`staging/` is a third served directory with its own widget name,
`DigmiMarketingStaging`. It is **not** built or updated by this workflow; the
publish step prints what it still advertises so that it is noticed rather than
discovered on a screen.

## Releasing

### Configured once, before the first run

| What | Where | Why |
| --- | --- | --- |
| `TIZEN_AUTHOR_P12_BASE64`, `TIZEN_AUTHOR_PASSWORD`, `TIZEN_DISTRIBUTOR_P12_BASE64`, `TIZEN_DISTRIBUTOR_PASSWORD` | repository **secrets** | the runner builds its own certificate profile; it never reads a `.pwd` file |
| `TIZEN_INSTALLER_URL`, `TIZEN_INSTALLER_SHA256` | repository **variables** | Samsung re-spins installers under one URL; the checksum is the only thing that says we got what we tested |
| Settings → Pages → Source = **GitHub Actions** | repository setting | see below |

Pages must be built by the workflow, not from the branch. While it is served
from the branch, a publish goes live on GitHub's schedule rather than ours: a
run whose live check fails still leaves `latest/` committed on `main`, and the
next unrelated push rolls it out to every screen with nobody watching. The
publish job checks this setting and stops before committing anything if it is
still `legacy`.

Flipping that switch also turns off GitHub's own branch-built deployment, which
is everything the release workflow does not deploy — a hand edit to a
descriptor, a change under `staging/`, anything in `src/`, and the rollback
path: a revert of a bad `production/latest/`. So a second workflow, **Deploy
site**, redeploys the site on every push to `main`. It has no inputs and does
nothing but publish the tree as it stands. A push made by the release workflow
uses `GITHUB_TOKEN` and does not trigger it, so the two never race over one
deployment.

The signing secrets are repository-wide on purpose, so that a build-only run
works from a feature branch. An Environment restricted to `main` would keep a
dispatch from any other ref away from the certificates entirely, at the cost of
being unable to test-build a branch. The cheaper protection with no such cost
is branch protection on `main` plus `CODEOWNERS` over `.github/workflows/` and
`scripts/` — the exposure here is write access to the repository, and anyone
holding that can add their own workflow regardless of where the secrets live.
Neither is in place today.

The JDK the runner installs is **not** verified against Tizen Studio 6.1. The
install step runs `tizen version` immediately afterwards precisely so that a
mismatch fails there, in one readable line, instead of inside the signing
block. If that is what breaks, the JDK version in the workflow is the first
thing to change.

### Running it

Actions → **Release widget** → Run workflow.

1. Bump `version` in `src/config.xml` **and** `appVersion` in `src/js/main.js`.
   The build fails if they disagree: `appVersion` is the only version a screen
   displays, so a build whose bundle and panel report different numbers is a
   build nobody can verify on site.
2. Run with both inputs off first. That builds, signs and verifies without
   touching the repository — use it to read the verification output and the
   signing identity. Expect the identity comparison to report a **different**
   author certificate than the published build, and expect the run to stay
   green anyway: the live package is signed by a key nobody here holds, so a
   run that publishes nothing has nothing to protect. The
   `accept_new_author_certificate` flag is not needed for this, and should not
   be ticked for it.
3. Run with **publish** on to commit `production/<version>/`.
4. Prove that build on **one panel, through the SSSP path** — put the `.wgt`
   and `sssp_config.xml` on a URL, point the panel's Custom App at that
   directory, reboot, and watch it come up on its own.
5. Only then run with **publish_latest** on. That is the step the fleet follows.

`force` has one job: overwriting a `production/<version>/` that already exists.
It is not needed for the first rollout. The published descriptor says
`<ver>1.0.7`, which is not a number, and the backwards gate treats that as a
warning rather than a block — every `<ver>` this pipeline emits is at least
10000, which is an increase whether a display reads the old string as an
integer or compares it as text.

**The live check is an alarm, not a gate.** The order is commit, push, deploy,
then verify, so by the time it reports a problem the release is already live.
That is the best available arrangement — the alternative, a branch-built site,
publishes on GitHub's schedule with nobody watching at all — but it means a red
live check calls for a decision, not a retry. The recovery is a revert on
`main`, which **Deploy site** then publishes; the fleet moves back only once a
`<ver>` higher than the bad one is published, so a revert alone will not pull a
build off screens that already took it.

Step 4 is not ceremony, and the method matters. A display refuses an update
signed by a different author certificate than the one it already carries, and
the only way to find out is to try it on a screen you can reach.

Do not prove it with `tizen install` over SDB. The same .wgt behaves differently
depending on how it arrives: installed over SDB it registers as a separate app
beside the Custom App player and **never auto-starts on boot**, while the SSSP
path registers it *as* the Custom App player and does. A screen in a shop window
has to come back by itself after a power cut, so SDB would prove the certificate
and nothing that matters about the product.

## Certificates

The workflow signs with certificates from repository secrets. Nothing is read
from a local `~/SamsungCertificate`.

| Secret | Contents |
| --- | --- |
| `TIZEN_AUTHOR_P12_BASE64` | `base64 -i author.p12` |
| `TIZEN_AUTHOR_PASSWORD` | its password |
| `TIZEN_DISTRIBUTOR_P12_BASE64` | `base64 -i distributor.p12` |
| `TIZEN_DISTRIBUTOR_PASSWORD` | its password |

Set them with `gh secret set`, never by pasting into a chat or a file.

### Creating the certificate profile

Commercial signage displays need a **Samsung** certificate at **Partner**
privilege. Samsung's TEP material states the rule directly: a Tizen certificate
*"allows only for using the Public Level API privileges"* and a Samsung
certificate *"is required if application uses TEP API"*. Anything the app needs
beyond public privileges — SystemControl, Timer, SyncPlay, b2bcontrol — is
unreachable without it, whatever config.xml declares. A generic Tizen
certificate, or a Samsung one at Public privilege, is reported to fail with
*error -3: invalid certificate chain* on Tizen 8.0 hardware. Do not read that
as a general rule: the build this fleet runs today is signed with a Tizen
Association certificate and installs and starts perfectly well. What a Tizen
certificate costs is narrower and certain — the partner-level privileges
`config.xml` declares are simply never granted, so `b2bcontrol`, `productinfo`
and the rest are unreachable however the app calls them.

A Samsung certificate is **valid for one year**. Renewal keeps the installed
estate updatable only if the same author key is reused: Certificate Manager's
*Use an existing author certificate* option *"will create a new author
certificate using the same RSA key"*. The key, and its password, are therefore
the one artefact that must never be lost — there is no password reset, and
without it the certificate can never be renewed and every display needs a
manual reinstall.

### Why a profile lists with every field N/A

`profiles.xml` points each key at a `.pwd` file holding its password. Certificate
Manager cannot open an encrypted `.p12` without it, so when that file is absent
every field — identity, expiry, even *Key file location* — reads N/A. The key is
not missing; the password is.

Two different things produce that, and they need different fixes.

**The VS Code Certificate Manager on macOS does not write `.pwd` at all.**
Verified on a profile created 2026-11-03: `profiles.xml` was written pointing at
`author.pwd` and `distributor.pwd`, and neither file was created anywhere on
disk. This is benign *if* the password is known — CI never reads `.pwd`, it takes
the password as a secret and builds the profile itself with `tizen
security-profiles add`. But it means **the password you type into the wizard is
the only copy**, so write it down then and there.

**A `.pwd` written on Windows is bound to that Windows account.** It is a DPAPI
blob — `df9d8cd0-1501-11d1-8c7a-00c04fc297eb` is DPAPI's provider GUID, visible
after Tizen's 4-byte length prefix. Copying `Tizen-data/` to OneDrive or another
machine carries the key across and strands the password: the `.p12` arrives
intact and permanently unopenable. That is the state of
`Tizen-data/keystore/author/DigmiTizen.p12`.

Either way the `.pwd` file is not a backup of the password. Keep your own.

### What this machine actually holds

Read from the unencrypted `author.crt` / `distributor.crt` beside each key
(2026-11-02):

| Profile | Author | Expires | Distributor privilege | DUIDs |
| --- | --- | --- | --- | --- |
| `TV` | `93295b0f…` CN=Digmi | 2026-11-10 | **Public** | `2DCPQL4LSAA66` |
| `Tizen7` | `93227dd2…` CN=Digmi | 2026-11-12 | **Public** | `2DCPQL4LSAA66` |
| `Digmi_Samsung_Partner_2026` | `670295c0…` O=Digmi Sweden AB | 2027-11-03 | **Partner** | `XTCPQL4LSAA4S`, `2DCPQL4LSAA66` |

All three are issued by `Samsung VD Author CA`. The 2026-11-03 profile is the
first to carry Partner privilege — `VD DEVELOPER Partner CA Class` rather than
`VD DEVELOPER Public CA Class` — so partner-level privileges are available on
this Samsung account, which was previously an open question.

One wrinkle in that profile: its author certificate has an **empty CN**
(`CN=, OU=, O=Digmi Sweden AB, L=Jönköping, ST=Jönköping, C=SE`) because the
wizard's author-name field was left blank while Additional Fields were filled.
Updates bind on the certificate itself, not on its CN, so this is cosmetic — but
it makes the profile harder to recognise in a build log than `CN=Digmi` was.

Note also that the VS Code extension offers **"Add individual DUIDs (up to 10
device)"**, where Samsung's own documentation for Tizen Studio states 50. Plan
for the lower number on this toolchain.

Three things follow, and none of them were assumed before the certificates were
read:

- **Neither is Partner.** Both distributor certificates are issued by `VD
  DEVELOPER Public CA Class`. No TEP API, no `b2bcontrol`, whatever `config.xml`
  declares — and renewing them as-is would not change that.
- **Neither registers a display.** Both carry the same single DUID, a bench
  device. No shop panel would accept a build signed by either.
- **Both are already unusable, not expiring.** Their `.pwd` files are absent, so
  the CLI cannot sign with them and Certificate Manager cannot renew them —
  renewal has to open the existing author key. This is why the profile lists in
  Certificate Manager with every field reading *N/A*: the `.p12` is found, the
  password beside it is not.

The build the fleet runs is signed by a third identity again — `e318dc37…`,
CN=Digmi, issued by **Tizen Developers CA**, valid to 2027-01-01 — whose key is
not on this machine under any password. The nearest candidate,
`Tizen-data/keystore/author/DigmiTizen.p12`, came from that same Tizen
certificate-generator path and still has its `.pwd`, but that file is the
Windows DPAPI blob described above.

1. Open Certificate Manager. In VS Code that is `Tizen Web: Run
   Certificate-Manager` or `Tizen TV: Run Certificate Manager` — the extensions
   bundle Samsung's CA chain (`vd_tizen_dev_partner2.crt` among it), so the
   Samsung profile type and Partner privilege are available without installing
   anything further. On a classic Tizen Studio install the **Samsung
   Certificate Extension** has to be added through its Package Manager first.
2. **+** → new profile. Create a fresh profile rather than editing an existing
   one; editing is unreliable.
3. Device type: **Samsung**.
4. Author certificate: create new, set a password, **write the password down**.
   The previous one was lost, which is part of why this document exists.
5. Distributor certificate: privilege level **Partner**, then add the **Unique
   Device ID** of every display that should accept the build (see below for
   which field that is). Samsung caps this at 50 *"for development purposes"*;
   selling beyond that means distributing through Seller Office and TBM
   instead — see *Distribution at scale*.
6. For each display: Device Manager → right-click → **Permit to install apps**.
   Mandatory, easily missed, and it has to be redone whenever the certificate
   profile changes.

The DUID to use is **Unique Device ID**, found under **Contact Samsung →
Product Information** on the display. Samsung's own TEP training material is
explicit and underlines it: *"Make sure to select correct DUID value – Unique
Device ID NOT Unique ID"*, with a screenshot of a QM43R marking `Unique ID` as
the incorrect value. It is a 13-character string such as `RLCN5JUZ3TEC4`, not a
UUID. Field guides circulating online say the opposite; Samsung's own material
is the one to follow, and the wrong field fails with *error -4: invalid
signature* after the certificate has already been issued.

## The signing identity

A display refuses an update signed by a different author certificate than the
one it already carries. The pipeline therefore compares the identity of each
build against `production/latest/DigmiMarketing.wgt` and refuses to continue
unless `accept_new_author_certificate` is set.

This is not theoretical here. The three published packages in this repository
carry three different author identities:

| Release | Author certificate |
| --- | --- |
| 1.0.5 | `7461c1fb…` |
| 1.0.7 (live) | `e318dc37…`, `CN=Digmi`, Tizen Developers CA, expires **2027-01-01** |
| 1.0.9 | `35c211a7…` (never distributable: different identity, already expired) |

The identity changed at every release, which is why the fleet cannot be updated
from a laptop that happens to have a certificate on it.

Every build prints this identity and its expiry, and warns at 90 and then 30
days out, because a certificate that lapses before the next release turns a
normal update into a manual reinstall on every screen.

Two consequences worth holding on to. The live certificate expires
**2027-01-01**, and its private key is not in our possession, so the installed
estate will need a one-time manual reinstall whatever else happens. And the key
chosen for the next identity becomes permanent: renewal only preserves
updatability when the same RSA key is reused, and there is no password reset.

## Distribution at scale

Everything above describes the self-hosted path: we sign a .wgt, serve it with
its descriptor, and point displays at that directory.

### Why the DUID list exists, and when it stops applying

The certificate Certificate Manager issues is not the real thing. Samsung's own
documentation is explicit: *"the distributor certificate that you create using
the Certificate Manager is actually called a **pseudo-distributor
certificate**. In fact, when you submit your application on the app store, your
distributor certificate will be switched to the actual distributor certificate
of the store."*

The DUID list is a property of that pseudo certificate, and its purpose is
anti-leak, not licensing: *"This ensures that the application can only be
installed on your device and the ones that you have approved even when your
package file is leaked. You can think of it as a 'personal' distributor
certificate."* The cap is **50 DUIDs**.

So per-display registration is a cost of **sideloading**, not a property of the
product. Signing and serving the .wgt ourselves means every new display has to
be added to the certificate, the certificate re-issued, and the package
re-signed. Going through Samsung's distribution means the device list is
replaced along with the certificate.

What is **not** confirmed is that a signage Custom App rides that same swap. The
page documenting it describes app-store submission generally; the TV Seller
Office distribution guide never mentions distributor certificates at all, and
its DUID list is a 30-day alpha test on a *different field* — "Unique ID" under
`Support > About This TV > Smart Hub Information`, not the "Unique Device ID"
under `Contact Samsung > Product Information` that signage certificates use.
That difference is itself a sign the two tracks are not the same thing.

This is the question that decides whether display number 51 can be sold, and it
is the one to put to Samsung in their own vocabulary: *does distributing a
signage Custom App through Seller Office and TBM replace the pseudo-distributor
certificate, as app-store submission does?*

### The production route as Samsung describes it

*"Application signed with Samsung Certificate can be uploaded to Seller Office
and later distributed via TBM."* Tizen Business Manager then handles enrolment
and Zero Touch configuration, and exposes a partner-gated Open API for
integrating device management into our own portal. Seller Office partnership is
requested online *"if a prior agreement has been made with your Samsung Content
Manager"* — so it starts with a Samsung relationship, not a form.

Until the question above is answered, treat the published `production/`
directories as test infrastructure rather than fleet distribution, and prove
releases on a single panel through the SSSP path.

## Keeping the toolchain pinned

The workflow downloads the Tizen Studio CLI and checks it against a recorded
hash, because Samsung re-spins installers under the same URL. Both values are
repository variables:

| Variable | How to refresh |
| --- | --- |
| `TIZEN_INSTALLER_URL` | the current `web-cli_Tizen_Studio_<version>_ubuntu-64.bin` download URL |
| `TIZEN_INSTALLER_SHA256` | `shasum -a 256` of that file, downloaded once and checked by hand |

A checksum mismatch stops the build. That is the intended behaviour — verify the
new binary before updating the pin.

## Building locally

Rarely needed, but useful when debugging the scripts themselves:

```sh
scripts/build-wgt.sh <certificate-profile-name>   # stages, signs, writes the descriptor
scripts/verify-wgt.sh .build/out                  # checks the result like a display would
```

Use the CLI, never the Tizen Studio GUI. The GUI rewrites `<name>` as `<n>` when
tabs are switched and packages IDE metadata along with the app.

## Reading a screen on site

The device panel — app version, model, tizenid, uuid, last API response, stage
geometry — is hidden by default. Press **INFO** or the **red** button on the
remote to toggle it.
