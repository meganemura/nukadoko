# 既存のプロジェクトに nukadoko を導入する

> 原文は adopting.md。
> 相違があれば原文が正。

このガイドは、コードとユニットテストをすでに持つプロジェクトを、最初の scenario が green になり、CI で走り、pull request に run サマリが載るところまで進めます。
Node のプロジェクトを前提にしています。
`package.json` のないリポジトリは、[Setup details](../README.ja.md#setup-details) の注記から始めてください。

各手順は、実行するコマンドと、それが書くものを示します。
以下の出力は、パックしたパッケージを scratch プロジェクトで実際に実行して写したものです。
そのプロジェクトの CLI `src/cli.ts` は `Hello, <name>!` を出力します。
README は同じプロジェクトを、すべてのファイルを全文で示しながらたどります。
[Beside your unit tests](../README.ja.md#beside-your-unit-tests) を参照してください。

## 1. nukadoko をインストールする

Node 22 系なら 22.18 以降、それ以外は 23.6 以降が必要です。
nukadoko を devDependency として、1 つの版に厳密に固定してインストールします:

```sh
npm install -D -E nukadoko
```

`-E` を付けると、caret の範囲ではなく `"nukadoko": "0.17.0"` が書かれます。
nukadoko が 0.x のあいだは、どのリリースでも公開 API が変わりえます。
新しい版へは意図して移り、そのときは [docs/upgrading.ja.md](upgrading.ja.md) を読んでください。

`page` か `request` を使う step には Playwright が必要です。
CLI のプロジェクトには要りません。
追加するときは [Install](../README.ja.md#install) に従ってください。

## 2. `nuka init` を実行する

プロジェクトの `package.json` があるディレクトリで実行します:

```sh
npx nuka init
```

```text
nukadoko.config.ts
features/steps
.gitignore
package.json
tsconfig.json
next: read node_modules/nukadoko/llms.txt, written for an agent: the loop, every command, and every finding code
```

`init` は `nukadoko.config.ts` と `features/steps/` を書き、3 つのファイルに行を追加します:

- `.gitignore` に `.nukadoko/`(state ディレクトリ)と、`.env`、`.env.*`、`!.env.example` を追加します。
- `package.json` に `"test:scenarios": "nuka run"` を追加します。
  人も CI も、この 1 つのコマンドを実行します。
- `tsconfig.json` の `include` が `features/**/*` と config ファイルを含んでいなければ、それらを追加します。
  `compilerOptions` が `rewriteRelativeImportExtensions` と `allowImportingTsExtensions` のどちらも書いていなければ、`"rewriteRelativeImportExtensions": true` も追加します。

オプションのフラグはここで決めてください。
`nukadoko.config.ts` ができたあとは、`nuka init` はもう一度の実行を拒否します。

- `--allure` は `allurerc.mjs` を書きます。
  これは失敗を Allure のカテゴリに振り分けます。
  付けなかった場合は、[examples/allure/allurerc.mjs](https://github.com/meganemura/nukadoko/blob/main/examples/allure/allurerc.mjs) を手でコピーします。
- `--server "<command>" --server-url <url>` は、request を送る scenario ごとにサーバを起動する fixture を書きます。
  [A server you start yourself](../README.ja.md#a-server-you-start-yourself) を参照してください。

CommonJS のプロジェクト(`"type": "module"` がないもの)では、代わりに `nukadoko.config.mts` が書かれ、`nuka scaffold` は step ファイルを `.mts` で書きます。
`.ts` の step ファイルもそこで動きますが、読み込むたびに Node が `MODULE_TYPELESS_PACKAGE_JSON` の警告を出します。

## 3. 最初の feature を書く

誰かが求めた振る舞いを 1 つ選び、その人の言葉で scenario を 1 つ書きます。
`features/greet.feature` として保存します:

```gherkin
Feature: greet

  Scenario: greets by name
    When I run greet with "Ada"
    Then the output says "Hello, Ada!"
```

## 4. 検査し、足りない step を scaffold する

`nuka check` はすべての feature ファイルと step ファイルを読み、何も実行しません:

```sh
npx nuka check
```

```text
error	undefined-step	features/greet.feature:4	No step definition matches "I run greet with "Ada""
  do: nuka scaffold --feature features/greet.feature
error	undefined-step	features/greet.feature:5	No step definition matches "the output says "Hello, Ada!""
  do: nuka scaffold --feature features/greet.feature
```

`do:` の行を実行します。
どの step にも一致しない行ごとに stub を 1 つ書き、各 stub をオプションを足して書き直すコマンドを出力します:

```sh
npx nuka scaffold --feature features/greet.feature
```

```text
features/steps/i-run-greet-with.ts
features/steps/the-output-says.ts
next: redo a stub in place with its line below, adding --command, --request, --from, or --description; --replace overwrites the stub while nobody has edited it:
  nuka scaffold i-run-greet-with --pattern 'I run greet with {value:string}' --replace
  nuka scaffold the-output-says --pattern 'the output says {value:string}' --then --replace
```

stub は、中身を書くまで `not implemented` を投げます。
よくある形なら、編集する代わりにオプションを付けて書き直します:

- `--command <entry point>` は、プログラムを空のディレクトリで実行し、`exitCode`、`stdout`、`stderr` を返す When の step を作ります。
- `--request "<METHOD> <path>"` は、HTTP request を 1 つ送り、`status` と `body` を返す When の step を作ります。
- `--then --from <step>.<key>` は、前の step が返した値を、その行のキャプチャと比べる Then の step を作ります。

pattern のキャプチャは、中身を表す名前に変えます:

```sh
npx nuka scaffold i-run-greet-with --pattern 'I run greet with {name:string}' --command src/cli.ts --description "Run greet in an empty scratch directory" --replace
npx nuka scaffold the-output-says --pattern 'the output says {text:string}' --then --from i-run-greet-with.stdout --description "greet printed exactly this line" --replace
npx nuka check
```

```text
ok: no issues found
```

`--command` はエントリポイントを `node` で実行します。
`.ts` ファイルどうしが `.js` の名前で import し合うプロジェクトでは、ビルド済みのプログラムを指定します(たとえば `--command dist/cli.js`)。
理由は README の [Beside your unit tests](../README.ja.md#beside-your-unit-tests) にあります。
どのオプションにも当てはまらない step は、`run` を自分で書きます。
すでにある語彙は `nuka steps` と `nuka describe <name>` で確認できます。

## 5. 実行する

```sh
npm run test:scenarios
```

npm の最初の行は、パッケージの名前とバージョンを名指します。

```text
> <name>@<version> test:scenarios
> nuka run

scenario 1/1  features/greet.feature:3  greets by name
  step 1/2  passed  0.1s  I run greet with "Ada"
  step 2/2  passed  0.0s  the output says "Hello, Ada!"
steps     .nukadoko/runs/run-20261018-232314-j5x1/steps/  2
summary   .nukadoko/runs/run-20261018-232314-j5x1/summary.md
run       .nukadoko/runs/run-20261018-232314-j5x1/run.json
1 scenario: 1 passed, 0 failed  (0s)
```

`nuka run` は先に `nuka check` を実行し、エラーがあれば止まります。
scenario が失敗すると、stderr にその step、エラー、step record、そしてその scenario だけを再実行する `nuka run features/greet.feature:3` のような `do:` の行が出ます。

最初の scenario を書いているあいだは、2 つのフラグが役に立ちます:

- `nuka run --probe` は、読み取り専用の Then をキャプチャを変えてもう一度実行します。
  それでも通る Then は、その行が言っていることを検査していません。
  scaffold が書いた比較を `assert.ok(actual.startsWith("Hello"))` に置き換えると、run は通ったまま note が 1 つ増えます:

  ```text
  note	then-passed-with-changed-capture	features/greet.feature:5	the output says "Hello, Ada!": step "the-output-says" passed with text "Hello, Ada!-probe" in place of "Hello, Ada!"
    fix: Make the step compare its result with the capture the message names; a step whose sentence also allows the changed value, such as "at least n", can stay as it is.
    do: nuka run features/greet.feature:3 --probe
  ```

- `nuka run --env <name>` は、`nukadoko.config.ts` の `environments` が名付けた environment に対して実行します。
  各 environment は自分の `baseURL`、`envFiles`、`policy` を持ちます。
  `policy: "read-only"` の environment は、`mutates: true` と宣言された step を実行前にすべて拒否します。
  `--command` の scaffold は `mutates: true` を書くので、プログラムが scratch ディレクトリの外を何も変えないなら `false` にします。
  [docs/spec.ja.md](spec.ja.md) の「Environment、secret」を参照してください。

## 6. run ディレクトリを読む

`nuka run` は毎回、`.nukadoko/runs/` の下にディレクトリを 1 つ書きます:

- `run.json` は run の結果です。
  断定、件数、そして各 scenario の record と再実行のコマンドを持ちます。
- `summary.md` は Markdown の run サマリです。
  GitHub Actions では、ジョブのサマリページにも載ります。
- `steps/<id>/record.json` は step record 1 つです。
  引数、バリデーション済みの結果、そしてツールが観測したもの(`runCommand` が起動したプロセスなど)を持ちます。
  evidence のファイル(trace、スクリーンショット、`http.jsonl`)はその隣に置かれます。
- `scenarios/<id>/` は、scenario が自分の evidence を書いたときにだけ、それを持ちます。
- `sources.json` は run が読んだ feature のテキストで、`exports` はこの run から `nuka report` が `.nukadoko/export/` の下に書いたファイルの一覧です。
  retention は run と一緒にそれらを消します。
  ほかの場所に書いたレポートは一覧に入りません。

既定では、nukadoko は新しいほうから 20 個の run を残します(`retention.runs`)。
`nuka clean` はそれらを消します。
`.nukadoko/` はコミットしないでください。
trace とスクリーンショットは redact されません。
全体の構成は [docs/spec.ja.md](spec.ja.md#state-directory) の「State directory」にあります。

## 7. `nuka report` でレポートを描き出す

`nuka report` は、終わった run をその run ディレクトリだけから描き出します。
run ディレクトリを指定しなければ、最新の run を使います。

```sh
npx nuka report --format markdown                        # the run summary, on stdout
npx nuka report --format allure                          # .nukadoko/export/allure-results/
npx nuka report --format messages --out messages.ndjson  # a cucumber-messages stream
```

Allure results をレポートにするには Allure 3 の CLI が要ります。
そのコマンドと、各コマンドに `--output` を付ける理由は [Reports fill themselves](../README.ja.md#reports-fill-themselves) にあります。

## 8. CI に加える

CLI か API のプロジェクトは、ユニットテストのあとに step を 1 つ足します:

```yaml
- run: npm run test:scenarios
```

workflow の全体、ブラウザを使う場合、run ディレクトリのアップロードと pull request への run サマリの投稿は [docs/ci.ja.md](ci.ja.md) にあります。

`features/`、`nukadoko.config.ts`、そして `package.json`、`tsconfig.json`、`.gitignore` の変更をコミットします。

## 次に読むもの

- coding agent は acceptance の skill([skills/acceptance/SKILL.md](../skills/acceptance/SKILL.md))を読み込みます。
  `nuka skill path` は、インストールした版の `skills/` ディレクトリを出力し、そこにそのコピーがあります。
- cucumber-js のスイートを持つプロジェクトは、import を 1 つ切り替えて取り込みます。
  [docs/migration.ja.md](migration.ja.md) を参照してください。
- 何かが実行される前に `nuka check` が捕まえるもの: [Wrong before it runs](../README.ja.md#wrong-before-it-runs)。
- すべてのコマンド、config のキー、record のフィールド: [docs/spec.ja.md](spec.ja.md)。

---

[English](adopting.md)
