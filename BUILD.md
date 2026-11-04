# Building and releasing DigmiMarketing

The widget's source lives in `src/`. Everything under `production/` and
`staging/` is build output.

Releases go through two workflows, not a laptop. **Release widget** builds,
signs and publishes `production/<version>/`. **Promote release** copies an
already-published version into the two directories the fleet follows, and never
builds or signs anything. Before they existed the package was built by hand in
Tizen Studio, which is how `production/latest/` came to serve 1.0.7 while 1.0.9
sat unreleased beside it — the fleet follows `latest/`, so no screen ever saw
it.

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
nothing but publish `main` as it stands.

The two can collide, narrowly: a push by a person during a release starts
Deploy site, and the older tree it deploys would undo the release. Two things
stop it. They share one concurrency group, so only one deploys at a time, and
Deploy site checks out `main` rather than the commit that triggered it, so a
run held behind a release publishes the release rather than the tree it was
queued for. Both are needed; neither alone is enough.

### The order of the cutover matters

`Deploy site` skips itself, with a warning, while Pages is still built from the
branch — so merging first does not turn `main` red. But do not flip the setting
before there is a workflow able to deploy: what gets served between the flip
and the first Actions deployment is **not** something this project has
verified, and if the answer is "nothing", the fleet's own `production/latest/`
404s. In that order:

1. Merge the branch. Pages is still `legacy`, GitHub's builder deploys the
   merge commit as before, and `Deploy site` skips with a warning.
2. Settings → Pages → Source → **GitHub Actions**.
3. Run **Deploy site** by hand from `main` straight away. That establishes the
   first workflow-built deployment and proves the path before any release
   depends on it. (`permissions: { pages: read }` is enough for `GET
   /repos/{owner}/{repo}/pages` — observed on the merge run of 2026-11-03,
   where the `gate` job read `build_type: legacy` with no 403. GitHub's API
   description still lists no fine-grained permission for that endpoint, so the
   job keeps its 403 arm.)
4. Only then the first **Release widget** run.

After the cutover the meaning of a skipped `Deploy site` run inverts. Before it,
skipping is correct — GitHub's own builder is doing the work. After it, a
skipped run means Pages has been switched back to the branch, and **nothing**
pushed to `main` is reaching displays, a revert included. The run writes that
to its summary page in as many words. Treat it as an outage, not a no-op.

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
3. Run with **publish** on to commit `production/<version>/`. **The first CI
   release needs `accept_new_author_certificate`.** Not because anything is
   wrong: the installed estate carries `e318dc37…`, whose private key nobody
   here holds, so no certificate we can put in a secret will ever match it.
   Ticking it is the decision to accept what "## The signing identity" below
   describes — a one-time manual reinstall on every screen in the field. Tick
   it once, knowing that, and not before. From the release after that the
   identities match and the flag stays off.
4. Prove that build on **one panel, through the SSSP path**. It is already
   served at its own URL — `…/production/<version>/` — so point the panel's
   Custom App at that directory, reboot, and watch it come up on its own.
5. Only then roll it out, with the **Promote release** workflow: Actions →
   Promote release → Run workflow, and type the version you just proved.

Step 5 is a separate workflow for one reason, and it is the reason this
pipeline exists. Running Release widget a second time **rebuilds**, and a
rebuild of one version is a different `.wgt` — fresh signature timestamps at
least — carrying the same `<ver>`. Rolling that out would hand the fleet a
package nobody tested, and displays that already have the version would never
re-download it anyway. Promote release copies the bytes that were proven. It
needs no certificates at all, and it re-runs the full verification against the
committed package before it moves anything, so a hand-built directory from
before this pipeline cannot be rolled out by typing its name into the form — it
fails the first check that reads its descriptor — `<ver>` is not an integer —
as `production/1.0.5` and `production/1.0.9` both do.

There is a shortcut: **publish** and **publish_latest** in the same Release
widget run. It builds, publishes and rolls out in one go, and what it skips is
step 4 — the fleet gets a package that was never on a screen. It exists for the
case where that is a considered decision. `publish_latest` on its own fails the
run immediately, because the publish job would not run at all and the rollout
would finish green having changed nothing.

Two failures worth recognising before they happen.

**The served state is broken, so the identity question cannot be answered.**
If a descriptor advertises a `<widgetname>` whose `.wgt` is not beside it, the
identity gate stops the run — including a build-only run with both inputs off,
which is otherwise the one run that cannot fail for anything outside the build.
It is deliberate: a display in that situation reads `<ver>`, decides to
upgrade, fetches the package and gets a 404, and there is no way to say what
the fleet is running or whether it would accept this build. Fix the served
directory first. An empty one is fine — it is the descriptor that makes a
directory served, not the files beside it.

**`src/` or `scripts/` has changed on main since this build started.** The build job builds from the
commit you dispatched; the publish job commits onto the tip of `main`, so that
its commit is a fast-forward and cannot undo a push that landed meanwhile. If
someone pushes to the source while a release is building, those two are no
longer the same tree — the package would be committed by a commit it is not a
build of, and if the version string did not change, nothing else would ever
notice. The publish job compares the two git tree ids and stops. Dispatch
again; nothing was committed.

`force` has one job: overwriting a `production/<version>/` that already exists.
Neither the first rollout nor a promotion needs it. The published descriptor
says `<ver>1.0.7`, which is not a number, and the backwards gate treats that as
a warning rather than a block — every `<ver>` this pipeline emits is at least
10000, which is an increase whether a display reads the old string as an
integer or compares it as text.

**The live check is an alarm, not a gate.** Both publishing workflows end with
it: `scripts/check-served.sh` fetches every directory they wrote, compares the
served `<ver>`, and then compares the served package against the local one byte
for byte. But the order is commit, push, deploy, then verify, so by the time it
reports a problem the release is already live.
That is the best available arrangement — the alternative, a branch-built site,
publishes on GitHub's schedule with nobody watching at all — but it means a red
live check calls for a decision, not a retry. The recovery is a revert on
`main`, which **Deploy site** then publishes; the fleet moves back only once a
`<ver>` higher than the bad one is published, so a revert alone will not pull a
build off screens that already took it.

A release that appears to hang may simply be waiting. All three workflows
share the `pages-deploy` group, and the two publishing ones also share a
workflow-level group, so a release or a promotion queued behind site
deployments sits there — and its own 30-minute timeout does not start counting
until the job starts. Both groups are `queue: max` rather than the default
`single`, which is deliberate: the default cancels whatever is already pending
when something new is queued, and that would let a dispatch silently throw away
a rollout waiting its turn. Look at the queue before cancelling anything.

`Deploy site` reports success when the deployment is accepted and verifies
nothing beyond that — the byte-level check belongs to the publishing
workflows. After a revert, check what is being served rather than assuming:

```sh
curl -s https://digmiorg.github.io/TizenMarketingWeb/production/latest/sssp_config.xml

# or, when you reverted to a CI-built release, the same check the workflows
# run — by bytes, against both served directories:
scripts/check-served.sh https://digmiorg.github.io/TizenMarketingWeb/ \
  <ver> DigmiMarketing production/latest/DigmiMarketing.wgt \
  production/latest production
```

The script compares integers, so it cannot confirm a revert all the way back to
the legacy `<ver>1.0.7</ver>` — it would report the descriptor as "absent or
non-integer" and fail while the right tree is in fact being served. For that
one case, read the `curl` output yourself.

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

A Samsung certificate is **valid for one year**, and renewal is issued over
the author key you already have. Samsung's two pages on it, quoted in full
because the difference between them matters:

> This renewed certificate will be the same as your original RSA key so
> upgrading your application is guaranteed.
> — <https://developer.samsung.com/galaxy-watch-tizen/getting-certificates/create.html>

> In this process, Samsung will issue a new author certificate for you using
> the same RSA key as in existing author certificate. You will be able to
> update your existing app **on Galaxy store** if your current author
> certificate is expired already.
> — <https://developer.samsung.com/galaxy-watch-tizen/getting-certificates/extend.html>

The first is unconditional. The second is about **store** publishing, and we
sideload over SSSP. That a renewal also keeps a sideloaded signage app
updatable follows from the first quote and from how the author signature works,
but it is an inference, nobody here has put a renewed certificate on a panel,
and elsewhere Samsung says only that *"the update must be signed with the same
author certificate as the original application"*. The release gates are built
around that gap rather than over it: see *The signing identity*.

The key, and its password, are therefore the one artefact that must never be
lost — there is no password reset, and without it the certificate can never be
renewed and every display needs a manual reinstall.

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
Updates bind on the author key, not on any name in the certificate, so this is
cosmetic — but it makes the profile harder to recognise in a build log than
`CN=Digmi` was.

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

A display refuses an update signed by a different author than the one it
already carries. What the gates compare is the author's **public key**, hashed
from its DER `SubjectPublicKeyInfo` by `scripts/author-identity.sh`, against
every package the fleet is served — both directories, each by the
`<widgetname>` its own descriptor advertises, so a rename cannot make the
comparison quietly skip itself. `scripts/author-identity-gate.sh` does that
and answers in three parts; each workflow then decides who may overrule it.

Both readings of *author* fail, in opposite directions, which is why the gate
reports three outcomes rather than two:

| What changed | What the gate does |
| --- | --- |
| nothing | passes quietly |
| the certificate, over the same key | passes, with a `::warning::` naming it as a renewal |
| the key | refuses, unless `accept_new_author_certificate` is set |

Comparing certificates alone would call every routine renewal a new author and
send someone to every screen in the field for nothing. Comparing keys alone
would wave a renewal through, and if a display turns out to bind on the whole
certificate the fleet would stop updating with no warning anywhere. The middle
row is the honest answer to a question Samsung's own pages leave open for
sideloaded apps: it does not block the renewal, and it does not pretend the
renewal is proven. **Watch the first screen take that update.**

None of this is theoretical here. The three published packages carry three
different keys, not merely three certificates (measured 2026-11-03 with
`scripts/author-identity.sh`):

| Release | Signing key | Author certificate |
| --- | --- | --- |
| 1.0.5 | `b279b279…` | `7461c1fb…`, `CN=Digmi AB` |
| 1.0.7 (live) | `c442303c…` | `e318dc37…`, `CN=Digmi`, Tizen Developers CA, expires **2027-01-01** |
| 1.0.9 | `b31d589c…` | `35c211a7…` (never distributable: different key, already expired) |

The key changed at every release, which is why the fleet cannot be updated from
a laptop that happens to have a certificate on it.

Every build prints the key, the certificate and the expiry, and warns at 90 and
then 30 days out — because a certificate that lapses before the next release
can no longer be renewed from its key, and that is what turns a normal update
into a manual reinstall on every screen.

Two consequences worth holding on to. The live certificate expires
**2027-01-01**, and its private key is not in our possession, so the installed
estate will need a one-time manual reinstall whatever else happens. And the key
chosen for the next identity becomes permanent: renewal only preserves
updatability when it is issued over that same RSA key, which means keeping the
`.p12` and a password that has no reset.

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

### Where the CLI keeps security profiles

In the data directory, which is a **sibling of the SDK named after it** — not a
directory inside it. The first run of this pipeline (41796421422, 2026-11-04)
pointed `profiles.path` at `$TIZEN_HOME/tools/certificate-generator/profiles.xml`
and `security-profiles add` answered *"Not found a file of security profiles.
Please check specified path."* That directory holds the certificate generator,
never the profiles.

The same run's installer output says where it does belong, and is the authority
here over any documentation:

```
* Data directory : /home/runner/work/TizenMarketingWeb/TizenMarketingWeb/.tizen-studio-data
Tizen CLI 2.5.25
```

So for `TIZEN_HOME=<workspace>/.tizen-studio` the profiles file is
`<workspace>/.tizen-studio-data/profile/profiles.xml`, and a default install
under `$HOME` is a different layout, not the rule.

The workflow does not rely on that alone. It reads the path back from `tizen
cli-config -l`, falls back to `${TIZEN_HOME}-data/profile/profiles.xml`, and
passes `-f` to `security-profiles add`, which creates the file at whatever path
the CLI itself resolves. `-A` makes the profile active so nothing downstream
depends on which profile a bare command would choose. Both options are on the
binary the installer produces, printed by `security-profiles add --help` in run
41846786550:

```
 -A (--active)                           Set this profile as active.
 …
 -f (--force)                            If there is no Profile XML, then
                                          generates a file.
```

(The two are twelve lines apart in that output, with the certificate options
between them.)

The key is `default.profiles.path`, all of it. `default.` is part of the name
rather than a marker for a value something else overrides — [Samsung's CLI page
for this product](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/command-line-interface.html)
documents it as "Default certificate profile path" beside
`default.sdb.timeout=<timeout value>`, and a timeout is a setting, not a
precedence rule. The workflow reads and writes that spelling.

It reads a bare `profiles.path` too, second. Do not "fix" the write over to
that spelling without reading the rest of this section: both are genuinely out
there, which is how the mistake happened. The reference docs above name the
prefixed one — so do the desktop and Unity recipes — but **the CLI itself
recommends the bare one.** `security-profiles add` ends by printing this, on
our own runner, in the green run:

```
Succeed to add 'digmi-ci' profile.
If want to sign by this, add the file of security profiles in CLI configuration
  like 'tizen cli-config "profiles.path=/home/runner/work/TizenMarketingWeb/TizenMarketingWeb/.tizen-studio-data/profile/profiles.xml"'.
```

So the CLI recommends a key that its own `cli-config -l` does not list, and
names the right path while doing it. The same two sentences appear in the forum
thread below, which is where they were first found.

Ranking it second is therefore not a judgement about which spelling is better
attested. The real reason is that the choice does not matter much: the step
reads both, the documented spelling first, and the fallback is the same path
under either reading.

Those two sentences were first found in [a thread about packaging a TV app in
Docker](https://forum.developer.samsung.com/t/solved-cant-package-tv-app-using-docker/22987),
before this pipeline had ever printed them itself, and the thread is still
worth reading for two further reasons. Its accepted
resolution — by the asker, confirmed by another developer in August 2025 who
needed the same thing in CI — **writes no `cli-config` key at all**: just
`dbus-run-session -- package.sh`, where the script unlocks the keyring, runs
`security-profiles add` and then `tizen package -s`. That is real-world
evidence that the write here is optional, better than reasoning from `-f`. And
it is independent confirmation of why this step wraps the whole script in
`dbus-run-session` rather than running it per command: the keyring has to stay
available between where the SDK writes the password and where it reads it back.

### What a real listing holds

Run [41846786550](https://github.com/digmiorg/TizenMarketingWeb/actions/runs/41846786550),
the first run in which this step got as far as `cli-config -l`, printed this on
a fresh install:

```
default.build.architecture=x86_64
default.build.compiler=gcc
default.build.configuration=Debug
default.csharp.buildtool.path=C:/Program Files/Microsoft Visual Studio/2022/Professional/Msbuild/Current/Bin/amd64/MSBuild.exe
default.csharp.toolchain=dotnet-cli
default.dotnet.tool.path=/usr/bin/dotnet
default.profiles.path=/home/runner/work/TizenMarketingWeb/TizenMarketingWeb/.tizen-studio-data/profile/profiles.xml
default.sdb.timeout=60000
```

Every key is `default.`-prefixed, there is no bare `profiles.path`, and
`default.profiles.path` already points at the data directory — which is why
nothing in the failed run was wrong about the layout. What was wrong was this
step's own write to `certificate-generator`. (The Windows MSBuild path on a
Linux runner is the installer's, not ours.)

Two things that run did **not** settle, so do not read them into it:

* **Whether a bare `profiles.path` would override the prefixed key.** The
  listing has no bare key to compete with, and the earlier failure proves
  nothing either way: at that point no `profiles.xml` existed anywhere, so
  `add` without `-f` would have failed whichever key it read.

  Reading both does **not** settle it, and neither does the fallback, which
  only runs when the prefixed value is empty. If a listing ever holds both and
  the CLI honours the bare one, the step resolves the prefixed path and the
  `mkdir` and `PROFILES_FILE` then aim at a file the CLI does not write.

  The likeliest cost of that is nothing visible: `-f` creates the file at
  whatever path the CLI resolved, `list -n` finds the profile and `package -s`
  signs. Run 41796421422 is not the precedent — it died because the path was
  wrong *and* `-f` was absent. What remains is a `profiles.xml` stranded
  outside what cleanup reaches, or an `add` that fails on a resolved path whose
  parent does not exist, if it turns out not to create intermediate directories
  — which nobody here has measured. Neither is a leaked password: that is in
  the keyring, which cleanup removes unconditionally, as it does
  `${TIZEN_HOME}-data/profile` where the measured value points, and a hosted
  runner is destroyed with the job in any case. The precondition has never been
  observed, which is why this is recorded rather than coded around.
* **Whether the write takes effect.** `default.profiles.path` already held the
  value the step writes, so a write that did nothing would look identical.

The write is guarded with a `::warning::` rather than left bare because an
unguarded non-zero exit there would kill the step under `errexit` for a write
whose effect is optional — `add -f` resolves the path itself, and the cleanup
step removes `${TIZEN_HOME}-data/profile` unconditionally, so a write that does
not take strands nothing. Run 41846786550 emitted no warning, so CLI 2.5.25
accepts the key.

The same run settled one more open question: `security-profiles list -n` exits
0 when the profile is there. The check after `add` is still a warning rather
than a gate, because the thing worth failing on is an unsigned package, and
`verify-wgt.sh` already refuses one.

### Testing the signing step without a runner

`scripts/signtest.py` cuts the `bash -c` block out of `release-widget.yml` and
runs it against a stub `tizen`, so the step can be changed without spending a
runner on each attempt:

```sh
python3 scripts/signtest.py                              # the workflow in this tree
python3 scripts/signtest.py /path/to/some/other/copy.yml # any other copy
```

Stock `python3` is enough — it needs no third-party modules. It uses
`shellcheck` when that is on PATH and says so when it is not. It exits
non-zero if any case fails, and also before the first case runs if the block
cannot be found or parsed, if `shellcheck` has something to say about it, or
if it contains an apostrophe.

What it covers is the list of bugs this one step has already had: the profiles
path, the key spelling read and the key spelling written, `-f` and `-A`
reaching `add`, the write being guarded, whitespace and carriage returns in the
path, and the rule that no apostrophe may appear inside the block — the block
is a single-quoted argument to `bash -c`, so one apostrophe silently turns the
rest of the script into shell words.

A test that cannot fail protects nothing, so the suite proves it bites rather
than asserting it:

```sh
python3 scripts/signtest.py --mutate
```

That puts each of those defects back into a copy of the workflow, one at a
time, runs the whole suite against it, and insists both that the suite goes red
and that it goes red on the case that defect is named for. A surviving mutant
is a failure. It takes a couple of minutes, which is why it is not the default.
If a substitution no longer matches the workflow, that is an error too: the
step has been reworked and the table above the cases needs rereading. Without
`shellcheck` on PATH one entry is skipped rather than failed, and the run says
so — the mutation set is smaller, and the exit status does not show it.

It cannot tell you that the real CLI accepts a flag or a key; only a run can.
`actionlint .github/workflows/release-widget.yml` is the other half, and it is
what caught the apostrophe the suite missed. Its four standing findings on this
file — two `queue: max` false positives and two shellcheck infos — are the
baseline; anything beyond them is new.

### What holds the signing secret on a runner

Three things, and only the first is obvious:

| Where | What it is |
| --- | --- |
| `$RUNNER_TEMP/certs` | the `.p12` files, decoded from the secrets |
| `$HOME/.local/share/keyrings` | the GNOME keyring, where `security-profiles add` puts the passwords. `--unlock` with an empty password persists it, and it outlives `dbus-run-session` |
| `profiles.xml` | **not** the password: `password=` is a path to a `.pwd` entry in that keyring. It names the secret rather than holding it |

The cleanup step deletes all three, and runs on failure as well as success. The
signing step exports the profiles path it resolved so that the file actually
used is the file removed.

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
