# nukadoko

> Gherkin のための生きたぬか床: 型付きの step、receipt、そして agent-first な CLI。

nukadoko は Gherkin を実行する agent-first のエンジンです。
feature ファイルは人間が合意するための言語のまま、構文の所有者は公式 Gherkin パーサのまま、ダッシュボードは Allure のまま、nukadoko は他の誰も担わない部分だけを所有します: 型付き step の契約、ツール自身が計測する実行記録(receipt)、そして「動きました」をレビュー可能な成果物に変える sign-off です。
Cucumber + Playwright からの移行は import の差し替え 1 つから始まります。
nukadoko がインストールするコマンドは `nuka` の 1 つです。

**Status: pre-0.1。**
M1 の engine core は実装済みです(`steps`、`describe`、`do`、`run`、`check`、`init`、`scaffold`、そして session、environment、secret)。
設計の全体は [docs/spec.ja.md](docs/spec.ja.md) にあります(原文は [docs/spec.md](docs/spec.md))。

## License

[MIT](LICENSE)
