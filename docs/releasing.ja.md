# リリースする

nukadoko はすでに npm にあります。
リリースは npm パッケージと、`package.json` の version に `v` を付けた git tag です。
`package.json` を変える `main` への push が [`.github/workflows/publish.yml`](../.github/workflows/publish.yml) を走らせます。
その `check` ジョブは `package.json` の version を読み、tag `v<version>` を探します。
依存の更新のあとのように、その tag が既にあれば、その実行は何もリリースしません。
無ければ publish ジョブが push された commit をインストールし、`dist/` をビルドし、このリポジトリ自身の CI と同じチェック(`npm run archstrict` を含む)を実行し、`npm run pack-check` と skill の作業例を実行してから `npm publish` します。
npm は GitHub Actions の OIDC で認証します。
リポジトリとパッケージがどちらも公開されているので、npm の provenance は自動で付きます。
GitHub の Environment `publish` が人のゲートです。
publish ジョブは承認されるまでそこで待ちます。

`npm publish` が成功したあと、3 つめのジョブがそのバージョンの tag と GitHub release を作ります。
そのジョブは publish ジョブが checkout したのと同じ commit を checkout し、`CHANGELOG.md` からそのバージョンの節だけを取り出し、publish した commit を指定して `gh release create --target` を実行します。
その呼び出しが、その commit に tag `v<version>` を作ります。
その tag を手で push する人はいません。
release が既にあれば、そのまま残します。
ジョブを再実行しても失敗しません。
publish ジョブの権限は `id-token: write` と `contents: read` です。
release ジョブの権限は `contents: write` です。
そのジョブは npm の OIDC トークンを持ちません。

パッケージが載せるのは、`dist/` にコンパイルした JavaScript(`nuka` の bin は `dist/cli.js`)、それに `src/`、`docs/`、`skills/`、`CHANGELOG.md`、`llms.txt` です。
`dist/` は `.gitignore` に入っています。
workflow が push された commit からそれをビルドします。
`README.md`、`README.ja.md`、`LICENSE`、`package.json` は npm が常に tarball へ入れるので、それらも入ります。

`package.json` は `prepublishOnly` を宣言していますが、`.npmrc` が `ignore-scripts=true` なので、`npm publish` のあいだその hook は走りません。
workflow が自分で `npm run build` を実行します。
そのビルド無しに publish すると、そこにあった `dist/` が何であれ、それが載ります。
`src/` より古いことも、そもそも無いこともあります。

workflow は `NPM_TOKEN` を読みません。
リポジトリの secrets にも置きません。
最初の 1 回をトークンで publish する手順はありません。
パッケージは既にあり、その Trusted Publisher も登録済みです。

## 一度だけの準備

Environment と trusted publisher は、2026-09-23 の時点で既に設定済みです。
どちらも、無くなったときだけ作り直します。
これは人の手順です。
このリポジトリの中の何も、Environment を作ったり trusted publisher を登録したりはしません。

1. GitHub リポジトリ `meganemura/nukadoko` には、名前が `publish` で承認する人を必須にした Environment があります。
   workflow のジョブは `environment: publish` を指定しているので、リリースの実行は承認されるまでそこで待ちます。

   その実行は tag からではなく、`main` ブランチから来ます。
   Environment が deployment の対象にできるブランチと tag を絞っているなら、その一覧で `main` を許可しなければなりません。
   `v*` の tag だけを許可する一覧は、その実行を拒否します。
   これはオーナーが、リポジトリ設定の Environments で変えます。

   trusted publisher を登録しても、承認待ちは開きません。
   承認待ちが現れるのは、リリースの実行が Environment `publish` に入ったときだけです。

   Environment が無ければ、次のリリースより前にそれを作り、承認する人を必須にします。
   そうしないと GitHub は最初の実行時に、承認する人が必須でない Environment を作り、チェックが通った瞬間に publish します。

2. npmjs.com の `nukadoko` パッケージには、`npm publish` を許可した GitHub Actions の trusted publisher が 1 つあります。
   フィールドは大文字小文字を区別します。
   publisher が無ければ、次の値で足します。

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

3. Actions からの OIDC による publish が動いたあと、パッケージ設定で二要素認証を必須にし、トークンによる publish を禁止できます。
   これは任意の強化です。
   trusted publisher はそのまま動きます。

## 各バージョン

1. `## Unreleased` の下にあるノートを新しいバージョンの見出しへ移し、`## Unreleased` は空にします。
   見出しの形は `CHANGELOG.md` に既にあるものを保ちます。
   release ジョブは、見出しが `##` とそのバージョンと空白で始まる節を取り出すからです。
   `package.json` と `package-lock.json` に同じ version を書きます。
   workflow はその version から tag を作ります。
   `docs/upgrading.md` と `docs/upgrading.ja.md` では、「to the next release」(日本語では「から次のリリースへ」)で終わる見出しを、このバージョンを名指すように書き換えます。
   たとえば `0.14.1 to 0.15.0` です。
   次に、英語と日本語の古い見出しの文言それぞれで `git grep -n "<古い見出しの文言>"` を実行し、その見出しの引用をすべて新しい見出しに書き換えます。
   その節を参照する箇条書きは見出しを引用しています。
   `tests/docs-cli-names.test.ts` は、そのファイルにもうない見出しの引用があると失敗します。

2. `npm run archstrict && npm run typecheck && npm test && npm run selftest && npm run pack-check && npm run skill-examples` を実行します。
   `pack-check` は本物の tarball を、このリポジトリの外の捨てプロジェクトへインストールし、そこで CLI を動かします。
   これが捕まえるのは、このリポジトリが devDependency にしか挙げていないパッケージへ `bin` が依存していることと、`dist/` が `src/` と一致していないことです。
   `skill-examples` は同じ tarball を `examples/acceptance/` の各プロジェクトのコピーへインストールし、そこで `nuka check`、`nuka run`、`nuka run --probe` を実行して、出力を `skills/nukadoko/references/examples/` にある実行記録と比べます。

3. 前回の tag から `skills/` が変わっているとき(`git diff --stat v<previous>..HEAD -- skills/` が行を出すとき)は、skill の評価を手で 1 回行います。
   `skills/nukadoko/references/examples/` の作業例を 1 つ選びます。
   捨てプロジェクトに、その例のプログラム(`examples/acceptance/` にあるそのプロジェクトの `src/`)を置き、この checkout の tarball をインストールします。
   インストールされた skill から、その例の Markdown ファイルを `node_modules/nukadoko/skills/nukadoko/references/examples/` で削除し、エージェントにはほかの写しも渡しません。
   エージェントにその例の「The ticket」の節を渡し、scenario を書いて実行するよう頼みます。
   エージェントが書いた feature を、`skills/nukadoko/references/scenario-rules.md` の各ルール S1 から S12 について、満たす、満たさない、該当しない、で採点します。
   その表と、例の名前と、モデルを `CHANGELOG.md` のこのバージョンの見出しの下に書き、release notes に載るようにします。
   満たさないルールは skill への指摘であって、このリリースを止める条件ではありません。
   この評価は 1 つのモデルの 1 回の実行で、もう 1 回実行すれば採点は変わりえます。

4. version の更新、changelog、upgrading の見出しを 1 つにまとめ、`chore: release <version>` として commit します。
   その commit を `queue` ブランチ経由で `main` に入れます。
   それが `main` に届くと workflow が始まります。
   `v*` の tag を手で push しません。
   tag は workflow が作ります。
   この publish は `publish.yml` だけです。
   checkout から `npm publish` を実行しません。

5. その Actions の実行で Environment `publish` を承認します。
   承認待ちは、その実行が Environment に入ったことです。
   workflow は `ubuntu-latest` の Node 24 を使い、npm の registry URL を設定します。
   npm 11.5.1 以上を要求します。
   その版が、GitHub の OIDC トークンを publish 用の資格情報に交換できる版だからです。
   `npm ci --ignore-scripts` と `npm run archstrict` を実行します(そのチェックはソースを読むので、ビルドもブラウザも要りません)。
   Playwright の Chromium をインストールし(`npm ci` はブラウザを入れず、スイートはそれを起動します)、`npm run build`、`npm run typecheck`、`npm test`、`npm run selftest`、`npm run pack-check`、`node scripts/skill-examples.ts` を実行し、追跡されているファイルが変わっていれば拒否します。
   `dist/` は `.gitignore` に入っているので、新しいビルド出力は想定どおりであり、pack されるのもそれです。
   そのあと `npm publish` を実行します。
   action は commit id にピンされ、`ci.yml` と同じです。
   このリポジトリは設定でそのピンを要求していて、tag は実行前に拒否されます。
   パッケージの `engines` は `^22.18.0 || >=23.6.0` のままです。
   Node 24 は publish ジョブであって、`nuka` を動かす人への新しい要件ではありません。

6. workflow の `release` ジョブが、`npm publish` のあとに GitHub release を作ります。
   `CHANGELOG.md` は、publish ジョブが checkout した commit から読みます。
   `--notes-file CHANGELOG.md` はすべてのバージョンのノートを貼るので、ジョブは見出しが `##` とそのバージョンと空白で始まる節だけを取り出してから、publish した commit を `--target` に指定して `gh release create` を実行します。
   その呼び出しが tag `v<version>` と release を作ります。
   両方を作るのはそのジョブです。
