# nukadoko

> A living pickling bed for your Gherkin: typed steps, receipts, and an agent-first CLI.

nukadoko is an agent-first engine that runs your Gherkin. Feature files stay the language humans agree in, the official Gherkin parser stays the owner of the syntax, Allure stays the dashboard, and nukadoko owns the part nobody else does: typed step contracts, tool-measured execution records (receipts), and sign-offs that turn "it works" into a reviewable artifact.

Migrating from Cucumber + Playwright starts with switching one import. nukadoko installs a single command: `nuka`.

**Status: pre-0.1.** The M1 engine core is implemented — `steps`, `describe`, `do`, `run`, `check`, `init`, `scaffold`, plus sessions, environments, and secrets. The full design lives in [docs/spec.md](docs/spec.md).

## License

[MIT](LICENSE)
