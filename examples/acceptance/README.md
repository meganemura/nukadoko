# The nukadoko skill's worked examples

Each directory here is the project one worked example under
[`skills/nukadoko/references/examples/`](../../skills/nukadoko/references/examples/)
was copied from: [`cli/`](cli/) for `cli.md`, [`http-api/`](http-api/) for
`http-api.md`, and [`workflow/`](workflow/) for `workflow.md`. The npm
package ships the Markdown and not these projects.

Two checks keep a project and its Markdown equal:

- `npm test` runs [`tests/skill-examples.test.ts`](../../tests/skill-examples.test.ts).
  It fails when a gherkin or ts block in the Markdown is not the whole
  content of one file here, or when a feature file here is not quoted.
- `npm run skill-examples` runs
  [`scripts/skill-examples.ts`](../../scripts/skill-examples.ts). It packs
  this checkout, installs the tarball into a copy of each project outside
  the repository, runs `nuka check`, `nuka run`, and `nuka tend`, and
  compares their output with the Markdown's transcript blocks. A `...`
  line in a transcript stands for any run of lines, durations are masked,
  and a finding line is compared up to its file. CI runs it.

A change to a project, or to what nukadoko prints for it, changes the
Markdown in the same commit. Run the project from a copy, install the
tarball there, and paste the real output:

```sh
npm run build
npm pack --ignore-scripts --pack-destination /tmp
cp -r examples/acceptance/cli /tmp/cli && cd /tmp/cli
npm install --omit=peer --ignore-scripts /tmp/nukadoko-<version>.tgz
npx nuka check && npx nuka run && npx nuka tend
```
