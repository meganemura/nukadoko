# Releasing

nukadoko is already on npm. A release is the npm package and a git tag
whose name is `v` plus the `package.json` version. Pushing that tag runs
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml). The
workflow checks the tag against `package.json`, installs the tagged
commit, builds `dist/`, runs the same checks this repository's own CI
runs, runs `npm run pack-check`, and runs `npm publish`. npm
authenticates with GitHub Actions OIDC. Provenance is attached
automatically because the repository and the package are public. The
GitHub Environment `publish` is the human gate: the job waits there
until it is approved.

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
one either. There is no token bootstrap: the package already exists, so
a Trusted Publisher can be attached directly.

The VS Code extension under `vscode/` is a different package, tagged
`vscode-v*`. A filter of only `v*` would match that prefix too, so the
workflow also excludes `vscode-v*`. It does not publish the extension.

## One-time setup

These are human steps. Nothing in this repository creates the
Environment or registers the trusted publisher.

1. On the GitHub repository `meganemura/nukadoko`, create an Environment
   named `publish` and require reviewers. The workflow job sets
   `environment: publish`, so a run waits until a reviewer approves it.
   Create the Environment before the first tag. Otherwise GitHub creates
   it on the first run with no required reviewers, and that run publishes
   as soon as the checks pass.

2. On the `nukadoko` package on npmjs.com, add one GitHub Actions trusted
   publisher. The fields are case-sensitive:

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

3. After the first publish from Actions succeeds, the package settings
   can require two-factor authentication and disallow token publishing.
   The trusted publisher keeps working.

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

4. Approve the `publish` environment on that Actions run. The workflow
   uses Node 24 on `ubuntu-latest` with the npm registry URL set. It
   requires npm 11.5.1 or newer, the release that can exchange a GitHub
   OIDC token for a publish. It runs `npm ci --ignore-scripts`, installs
   Playwright's Chromium (the suite launches it, and `npm ci` never
   does), `npm run build`, `npm run typecheck`, `npm test`, `npm run
   selftest`, and `npm run pack-check`, then refuses the run if any
   tracked file changed. `dist/` is gitignored, so the new build output
   is expected and is what gets packed. Then it runs `npm publish`.
   Actions are pinned to commit ids, the same way `ci.yml` is: this
   repository requires that pin, and a tag would be refused before the
   job ran. The package `engines` field stays `>=20`. Node 24 is the
   publish job, not a new requirement for people running `nuka`.

5. `--notes-file CHANGELOG.md` would paste every version's notes into
   the release, so extract that version's section first. Set `version`
   to the version you tagged:

   ```sh
   version=0.12.0
   awk -v version="$version" '$0 ~ "^## " version {f=1; next} /^## / {f=0} f' CHANGELOG.md > notes.md
   gh release create "v$version" --title "v$version" --notes-file notes.md
   ```
