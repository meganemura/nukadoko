# リリースする

nukadoko はすでに npm にあります。
リリースは npm パッケージと、`package.json` の version に `v` を付けた git tag です。
その tag を push すると [`.github/workflows/publish.yml`](../.github/workflows/publish.yml) が走ります。
workflow は tag と `package.json` を突き合わせ、その commit をインストールし、`dist/` をビルドし、このリポジトリ自身の CI と同じチェックを実行し、`npm run pack-check` を実行してから `npm publish` します。
npm は GitHub Actions の OIDC で認証します。
リポジトリとパッケージがどちらも公開されているので、npm の provenance は自動で付きます。
GitHub の Environment `publish` が人のゲートです。
ジョブは承認されるまでそこで待ちます。

パッケージが載せるのは、`dist/` にコンパイルした JavaScript(`nuka` の bin は `dist/cli.js`)、それに `src/`、`docs/`、`skills/`、`CHANGELOG.md`、`llms.txt` です。
`dist/` は `.gitignore` に入っています。
workflow が tag の付いた commit からそれをビルドします。
`README.md`、`README.ja.md`、`LICENSE`、`package.json` は npm が常に tarball へ入れるので、それらも入ります。

`package.json` は `prepublishOnly` を宣言していますが、`.npmrc` が `ignore-scripts=true` なので、`npm publish` のあいだその hook は走りません。
workflow が自分で `npm run build` を実行します。
そのビルド無しに publish すると、そこにあった `dist/` が何であれ、それが載ります。
`src/` より古いことも、そもそも無いこともあります。

workflow は `NPM_TOKEN` を読みません。
リポジトリの secrets にも置きません。
最初の 1 回をトークンで publish する手順はありません。
パッケージは既にあるので、Trusted Publisher を直接付けられます。

`vscode/` の VS Code 拡張は別パッケージで、tag は `vscode-v*` です。
`v*` だけのフィルタはその接頭辞にも一致するので、workflow は `vscode-v*` を除外します。
この workflow は拡張を publish しません。

## 一度だけの準備

これは人の手順です。
このリポジトリの中の何も、Environment を作ったり trusted publisher を登録したりはしません。

1. GitHub リポジトリ `meganemura/nukadoko` に、名前が `publish` の Environment を作り、承認する人を必須にします。
   workflow のジョブは `environment: publish` を指定しているので、承認されるまで実行は待ちます。
   最初の tag より前に Environment を作ります。
   そうしないと GitHub は最初の実行時に、承認する人が必須でない Environment を作り、チェックが通った瞬間に publish します。

2. npmjs.com の `nukadoko` パッケージに、GitHub Actions の trusted publisher を 1 つ足します。
   フィールドは大文字小文字を区別します。

   - Organization or user: `meganemura`
   - Repository: `nukadoko`
   - Workflow filename: `publish.yml` (ファイル名。`.yml` を含む)
   - Environment name: `publish`
   - Allowed action: `npm publish`

   2026-09-03 より後に作った trusted publisher は、最初から `npm stage publish` が許可されています。
   `npm publish` も選びます。
   `publish.yml` が実行するのは `npm publish` です。

   `package.json` の `repository.url` は既に `git+https://github.com/meganemura/nukadoko.git` です。
   npm はその URL を workflow のリポジトリと突き合わせます。

3. Actions からの最初の publish が成功したあと、パッケージ設定で二要素認証を必須にし、トークンによる publish を禁止できます。
   trusted publisher はそのまま動きます。

## 各バージョン

1. `## Unreleased` の下にあるノートを新しいバージョンの見出しへ移し、`## Unreleased` は空にします。
   見出しの形は `CHANGELOG.md` に既にあるものと同じです。
   `package.json` に同じ version を書きます。
   先頭の `v` を除いた tag がその version です。
   両者が違えば workflow は止まります。

2. `npm run typecheck && npm test && npm run selftest && npm run pack-check` を実行します。
   `pack-check` は本物の tarball を、このリポジトリの外の捨てプロジェクトへインストールし、そこで CLI を動かします。
   これが捕まえるのは、このリポジトリが devDependency にしか挙げていないパッケージへ `bin` が依存していることと、`dist/` が `src/` と一致していないことです。

3. `chore: release <version>` として commit します。
   `v<version>` を tag します。
   commit と tag を push します。
   tag の push が workflow を開始します。
   この publish は `publish.yml` だけです。
   checkout から `npm publish` を実行しません。

4. その Actions の実行で Environment `publish` を承認します。
   workflow は `ubuntu-latest` の Node 24 を使い、npm の registry URL を設定します。
   npm 11.5.1 以上を要求します。
   その版が、GitHub の OIDC トークンを publish 用の資格情報に交換できる版だからです。
   `npm ci --ignore-scripts` を実行し、Playwright の Chromium をインストールし(`npm ci` はブラウザを入れず、スイートはそれを起動します)、`npm run build`、`npm run typecheck`、`npm test`、`npm run selftest`、`npm run pack-check` を実行し、追跡されているファイルが変わっていれば拒否します。
   `dist/` は `.gitignore` に入っているので、新しいビルド出力は想定どおりであり、pack されるのもそれです。
   そのあと `npm publish` を実行します。
   action は commit id にピンされ、`ci.yml` と同じです。
   このリポジトリは設定でそのピンを要求していて、tag は実行前に拒否されます。
   パッケージの `engines` は `>=20` のままです。
   Node 24 は publish ジョブであって、`nuka` を動かす人への新しい要件ではありません。

5. `--notes-file CHANGELOG.md` はすべてのバージョンのノートをリリースへ貼るので、先にそのバージョンの節だけ取り出します。
   `version` は tag したバージョンにします。

   ```sh
   version=0.12.0
   awk -v version="$version" '$0 ~ "^## " version {f=1; next} /^## / {f=0} f' CHANGELOG.md > notes.md
   gh release create "v$version" --title "v$version" --notes-file notes.md
   ```
