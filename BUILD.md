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
| `<size>` | the exact byte count of the `.wgt` | the display fetches the descriptor and then declines the package |
| `<widgetname>` | identical to `<name>` in `config.xml` | install fails |

The package directory should hold **app files only**. The published 1.0.7
package carries `.gitignore`, `.gitattributes`, `Build/` and a nested
`tizen5.wgt`, and runs, so this is hygiene rather than a hard rule: a smaller
package, fewer signed files, and nothing in the artefact that nobody meant to
ship. Keep it anyway — a build that packages whatever happens to be in the
working tree is a build whose contents depend on who ran it.

Pointing a display at a bare web page does not work. `<type>url</type>` in the
descriptor is silently ignored on current firmware; only a signed `.wgt` is
accepted.

## Releasing

Actions → **Release widget** → Run workflow.

1. Bump `version` in `src/config.xml` **and** `appVersion` in `src/js/main.js`.
   The build fails if they disagree: `appVersion` is the only version a screen
   displays, so a build whose bundle and panel report different numbers is a
   build nobody can verify on site.
2. Run with both inputs off first. That builds, signs and verifies without
   touching the repository — use it to read the verification output and the
   signing identity.
3. Run with **publish** on to commit `production/<version>/`.
4. Prove that build on **one panel, through the SSSP path** — put the `.wgt`
   and `sssp_config.xml` on a URL, point the panel's Custom App at that
   directory, reboot, and watch it come up on its own.
5. Only then run with **publish_latest** on. That is the step the fleet follows.

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

Two consequences worth holding on to. The live certificate expires
**2027-01-01**, and its private key is not in our possession, so the installed
estate will need a one-time manual reinstall whatever else happens. And the key
chosen for the next identity becomes permanent: renewal only preserves
updatability when the same RSA key is reused, and there is no password reset.

## Distribution at scale

Everything above describes the self-hosted path: we sign a .wgt, serve it with
its descriptor, and point displays at that directory. Samsung treats that as the
development arrangement — the 50-DUID cap on the distributor certificate is
stated as being *"for development purposes"*.

The production path, in Samsung's own words, is different: *"Application signed
with Samsung Certificate can be uploaded to Seller Office and later distributed
via TBM."* Tizen Business Manager then handles enrolment and Zero Touch
configuration, and exposes a partner-gated Open API for integrating device
management into our own portal.

Two things gate that route, neither of them technical:

- Seller Office partnership is requested online *"if a prior agreement has been
  made with your Samsung Content Manager"* — so it starts with a Samsung
  relationship, not a form.
- Whether Seller Office distribution removes the DUID list entirely for signage
  Custom Apps is **not confirmed**. It is the question that decides whether we
  can sell display number 51, and it is open with Samsung.

Until that is answered, treat the published `production/` directories as test
infrastructure rather than fleet distribution, and prove releases on a single
panel through the SSSP path.

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
