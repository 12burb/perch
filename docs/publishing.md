# Publishing the remaining install lanes

Two ways in work without anyone doing anything: [`curl | sh`](install.md) and
[`docker compose up`](deploy.md). Two more work because their manifest lives in this repository and
the release workflow keeps it current: **nix** (`flake.nix`) and **Homebrew** (`Formula/perch.rb`).

The rest need a credential or a setting that cannot live in a repository, so they are a person's job
once. This page is that job, written down: four runbooks, each independent, each ending in something
you can check.

| Lane | Needs | Roughly |
|---|---|---|
| [npm](#1-npm) | an npm access token as a repository secret | 10 minutes |
| [The docs site](#2-the-docs-site) | two repository settings, no secret | 5 minutes |
| [AUR](#3-aur) | an SSH key on an AUR account | 20 minutes |
| [winget](#4-winget) | a GitHub PAT, then someone else's review | 30 minutes, then days |

---

## 1. npm

`npx perch-dev@latest dev` and `npm i perch-bot-sdk` are documented and currently 404. The release
workflow already builds and publishes both; it stops at the missing token.

Both names are **unscoped**, so they are first-come on the public registry. Nothing reserves them
until the first publish.

1. **Check the names are still free.** `npm view perch-dev` and `npm view perch-bot-sdk` should both
   answer `404`. If either is taken, stop here — the name in `scripts/build-cli.ts` and
   `scripts/build-bot-sdk.ts` has to change first, and so does every doc that names it.
2. **Sign in at [npmjs.com](https://www.npmjs.com)** and turn on 2FA if it is not on.
3. **Create a token.** Avatar → Access Tokens → Generate New Token → **Granular Access Token**.
   - *Packages and scopes*: **Read and write**. The packages do not exist yet, so the only thing you
     can select is **All packages**; narrow it to the two after the first publish.
   - *Expiration*: pick one and put it in a calendar. A token that expires unnoticed is a release
     that quietly publishes nothing — which is the failure this page exists to undo.
   - *IP allowlist*: leave empty. GitHub's runners have no fixed addresses.
   - A classic **Automation** token works too and is simpler, but it is account-wide and never
     narrows.
4. **Add it to the repository.** Settings → Secrets and variables → **Actions** → Secrets → New
   repository secret → name `NPM_TOKEN`, value the token.
5. **Release.** Either cut the next version, or Actions → Release → Run workflow with the version
   that is already out; the publish job runs `npm publish --provenance --access public` for both
   packages. Provenance needs `id-token: write`, which that job already has.
6. **Check.** `npm view perch-dev version` matches the release, and `npx perch-dev@latest --version`
   prints it. The run's summary says which lanes it published to.
7. **Narrow the token** to `perch-dev` and `perch-bot-sdk` now that both exist.

## 2. The docs site

`docs/` is built on every push and attached to every release as a tarball, and published by
[`docs.yml`](../.github/workflows/docs.yml) — which does nothing until Pages is on. No secret.

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.** There is no branch to
   pick; the workflow supplies the files.
2. **Settings → Secrets and variables → Actions → Variables → New repository variable**:
   `DOCS_PAGES` = `on`. This is what lets a published release deploy on its own.
3. **Actions → Docs site → Run workflow** (on `main`) for the first deploy. `workflow_dispatch`
   ignores the variable, so you can run this before step 2 to see it work.
4. **Check.** `https://<owner>.github.io/perch/` serves the site, search included. The first deploy
   can take a minute longer while Pages provisions.
5. From then on every published release republishes it, titled with that version.

**A custom domain**, if you want one: Settings → Pages → Custom domain, then set two more
repository variables so Astro builds the right links — `DOCS_SITE` (e.g. `https://perch.example`)
and `DOCS_BASE` = `/`. Without those the site is built for a project page under `/perch/` and every
link on a custom domain points one directory too deep.

## 3. AUR

`yay -S perch-bin` finds nothing: the release builds a `PKGBUILD` and nobody has pushed it. The AUR
authenticates over SSH, so **this is the one lane a deploy key is for**.

1. **Create an account** at [aur.archlinux.org](https://aur.archlinux.org) (separate from the Arch
   forums).
2. **Make a key for this and nothing else**: `ssh-keygen -t ed25519 -f ~/.ssh/aur -C "aur@perch"`.
   Leave the passphrase empty if CI will ever use it.
3. **My Account → SSH Public Key** → paste `~/.ssh/aur.pub`.
4. **Tell ssh about it**, in `~/.ssh/config`:
   ```
   Host aur.archlinux.org
     User aur
     IdentityFile ~/.ssh/aur
   ```
5. **Clone the name.** `git clone ssh://aur@aur.archlinux.org/perch-bin.git` — an empty repository
   is normal, and the name becomes yours on the first push.
6. **Copy the `PKGBUILD`** from the release's assets into it.
7. **Generate `.SRCINFO`.** The AUR refuses a push without one, and `scripts/packaging.ts` does not
   write it (it is derived from the `PKGBUILD` by Arch's own tooling):
   ```sh
   makepkg --printsrcinfo > .SRCINFO                    # on Arch
   docker run --rm -v "$PWD:/pkg" -w /pkg \
     archlinux:base-devel makepkg --printsrcinfo > .SRCINFO   # anywhere else
   ```
8. **Push.** `git add PKGBUILD .SRCINFO && git commit -m "perch-bin 0.3.0" && git push`.
9. **Check.** `yay -S perch-bin` on an Arch machine installs it and `perch --version` matches.
10. **For later releases** the same three files change. To let CI do it, add the *private* key as a
    repository secret and a step that clones, copies, regenerates `.SRCINFO` and pushes.

## 4. winget

`winget install Perch.Perch` finds nothing: the manifests are built but never submitted.
`microsoft/winget-pkgs` takes them by pull request, and a human reviews the first one.

The three generated files are submission-shaped already — `InstallerType: portable` with
`Commands: [perch]`, which is what a single `.exe` that is not an installer should say.

1. **On Windows**, `winget install Microsoft.WingetCreate`.
2. **Create a GitHub PAT** (classic, scope `public_repo`). `wingetcreate` uses it to fork and open
   the pull request as you.
3. **Submit**, with the three `Perch.Perch.*.yaml` files from the release:
   ```powershell
   wingetcreate submit --token <PAT> .\Perch.Perch.yaml .\Perch.Perch.installer.yaml .\Perch.Perch.locale.en-US.yaml
   ```
   By hand instead: fork `microsoft/winget-pkgs`, put the three files in
   `manifests/p/Perch/Perch/0.3.0/`, run `winget validate --manifest .`, and open the PR.
4. **Wait.** A bot validates, then a maintainer reviews. A first submission gets more scrutiny than
   an update — expect questions, and expect days rather than minutes.
5. **Check**, after it merges: `winget install Perch.Perch`.
6. **For later releases**:
   ```powershell
   wingetcreate update Perch.Perch --version <version> --urls <installer url> --submit --token <PAT>
   ```

---

## What each one changes

[`docs/install.md`](install.md#package-managers) has a table of which lanes work today. It is
written by hand, so **update that row when a lane lands** — a table that says "not yet" about
something that has worked for a month is the same problem as the one this page is fixing.
