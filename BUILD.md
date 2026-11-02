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

The package directory must also hold **app files only**. Tizen signs everything
it finds, so a stray `.gitignore` or `Build/` produces "unsigned file found".

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
privilege. A generic Tizen certificate, or a Samsung one at Public privilege,
fails with *error -3: invalid certificate chain* — current C-series hardware
(QBC/QMC/QHC) rejects it outright.

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
5. Distributor certificate: privilege level **Partner**, then add the **EMUID**
   of every display that should accept the build. Up to 50 per certificate;
   beyond that the fleet needs a Partner certificate from Samsung's partner
   portal.
6. For each display: Device Manager → right-click → **Permit to install apps**.
   Mandatory, easily missed, and it has to be redone whenever the certificate
   profile changes.

EMUID is the UUID-shaped identifier on the display's **Menu → Support → About**
screen. It is not the "Unique Device ID" shown next to it; that one is for
Samsung server registration.

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
