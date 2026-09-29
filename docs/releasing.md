# Releasing

nukadoko is already on npm. A release is the npm package and a git tag
whose name is `v` plus the `package.json` version. Pushing that tag runs
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml). The
workflow checks the tag against `package.json`, installs the tagged
commit, builds `dist/`, runs the same checks this repository's own CI
runs, runs `npm run pack-check`, and runs `npm publish`. npm
authenticates with GitHub Actions OIDC.
Provenance is attached automatically because the repository and the
package are public. The GitHub Environment `publish` is the human
gate: the publish job waits there until it is approved.

After `npm publish` succeeds, a second job creates the GitHub release
for that version. It checks out the same commit the publish job
checked out, extracts this version's section of `CHANGELOG.md`, and
runs `gh release create --verify-tag`. A release that already exists
is left in place, so running the same tag again does not fail. The
publish job's permissions are `id-token: write` and `contents: read`.
The release job's permission is `contents: write`. That job does not
hold the npm OIDC token.

The package ships compiled JavaScript in `dist/` (the `nuka` bin is
`dist/cli.js`), plus `src/`, `docs/`, `skills/`, `CHANGELOG.md`, and
`llms.txt`. `dist/` is gitignored. The workflow builds it from the
tagged commit. `README.md`, `README.ja.md`, `LICENSE`, and
`package.json` are in the tarball because npm always packs them.

`package.json` declares `prepublishOnly`, and `.npmrc` sets
`ignore-scripts=true`, so that hook does not fire during `npm publish`.
The workflow runs `npm run build` itself. Publishing without that build
would ship whatever `dist/` happened to be there, which may be older
than `src/` or missing entirely.

The workflow stores no `NPM_TOKEN`. The repository secrets do not keep
one either. There is no token bootstrap. The package already exists, and
its Trusted Publisher is already registered.

The VS Code extension under `vscode/` is a different package, tagged
`vscode-v*`. A filter of only `v*` would match that prefix too, so the
workflow also excludes `vscode-v*`. It does not publish the extension.

## One-time setup

The Environment and the trusted publisher are already configured, as of
23 September 2026. Recreate either only when it is missing. These are
human steps. Nothing in this repository creates the Environment or
registers the trusted publisher.

1. The GitHub repository `meganemura/nukadoko` has an Environment named
   `publish` with required reviewers. The workflow job sets
   `environment: publish`, so a `v*` tag run waits there until a
   reviewer approves it.

   Registering the trusted publisher does not open a pending approval.
   The approval appears only when a `v*` tag run enters the Environment
   `publish`.

   If the Environment is missing, create it and require reviewers before
   the next tag. Otherwise GitHub creates it on the first run with no
   required reviewers, and that run publishes as soon as the checks pass.

2. The `nukadoko` package on npmjs.com has one GitHub Actions trusted
   publisher, allowed to run `npm publish`. The fields are
   case-sensitive. If the publisher is missing, add it with these
   values:

   - Organization or user: `meganemura`
   - Repository: `nukadoko`
   - Workflow filename: `publish.yml` (the filename, including `.yml`)
   - Environment name: `publish`
   - Allowed action: `npm publish`

   A trusted publisher created after 3 September 2026 starts with
   `npm stage publish` allowed. Select `npm publish` as well.
   `publish.yml` runs `npm publish`.

   `package.json` `repository.url` is already
   `git+https://github.com/meganemura/nukadoko.git`. npm checks that URL
   against the workflow repository.

3. After OIDC publishing from Actions works, the package settings can
   require two-factor authentication and disallow token publishing.
   That is optional hardening. The trusted publisher keeps working.

## Each version

1. Move the notes under `## Unreleased` to a new version heading and
   leave `## Unreleased` empty. The heading shape is the one already in
   `CHANGELOG.md`. Set the same version in `package.json`. The tag,
   without the leading `v`, is that version. The workflow stops when
   they differ.

2. Run `npm run typecheck && npm test && npm run selftest && npm run pack-check`.
   `pack-check` installs the real tarball into a throwaway project
   outside this repository and drives the CLI there. That is what catches
   a `bin` that depends on a package this repository only lists as a
   devDependency, and a `dist/` that does not match `src/`.

3. Commit as `chore: release <version>`. Tag `v<version>`. Push the
   commit and the tag. The tag push starts the workflow. This publish
   is `publish.yml` only. Do not run `npm publish` from a checkout.

4. Approve the `publish` Environment when that Actions run asks for it.
   The pending approval is that run entering the Environment. The
   workflow uses Node 24 on `ubuntu-latest` with the npm registry URL
   set. It requires npm 11.5.1 or newer, the release that can exchange a
   GitHub OIDC token for a publish. It runs `npm ci --ignore-scripts`,
   installs Playwright's Chromium (the suite launches it, and `npm ci`
   never does), `npm run build`, `npm run typecheck`, `npm test`,
   `npm run selftest`, and `npm run pack-check`, then refuses the run
   if any tracked file changed. `dist/` is gitignored, so the new build
   output is expected and is what gets packed. Then it runs
   `npm publish`. Actions are pinned to a full-length commit SHA, written
   `uses: action@<40-hex> # vX.Y.Z`, the same way `ci.yml` is. This
   repository has `sha_pinning_required` enabled, so a tag would be
   refused before the job ran. The package `engines` field stays `>=20`.
   Node 24 is the publish job, not a new requirement for people running
   `nuka`.

5. The workflow's `release` job creates the GitHub release after
   `npm publish`. It reads `CHANGELOG.md` from the commit the publish
   job checked out. `--notes-file CHANGELOG.md` would paste every
   version's notes, so the job extracts only the section whose heading
   starts with `##` plus that version and a space, then runs
   `gh release create` with `--verify-tag`. Creating the release is
   that job.
