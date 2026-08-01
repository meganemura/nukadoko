# nukadoko

> Gherkin のための生きたぬか床: 型付きステップ、実行記録、agent-first な CLI。

nukadoko は Gherkin を実行する agent-first のエンジンです。
feature ファイルは人間が合意するための言語のまま、構文の所有者は公式 Gherkin パーサのまま、ダッシュボードは Allure のまま、nukadoko は他の誰も担わない部分だけを所有します: 型付きステップ契約、ツール自身が計測する実行記録(レシート)、そして「動きました」をレビュー可能な成果物に変えるサインオフです。
Cucumber + Playwright からの移行は import の差し替え 1 つから始まります。
nukadoko がインストールするコマンドは `nuka` の 1 つです。

**Status: 設計フェーズ。**
まだ何も動きません。
設計の全体は [docs/spec.md](docs/spec.md) にあります。

## License

[MIT](LICENSE)
