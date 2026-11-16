# nukadoko のガイド

> 原文は guide.md。
> 相違があれば原文が正。

[README](../README.ja.md) は、nukadoko が何かを述べ、最初の scenario をたどり、run がどう判定されるかを説明し、1 つの step で CI に載せます。
このガイドは、nukadoko を使うプロジェクトが出会う残りのことをまとめます。
設計そのものは [spec.ja.md](spec.ja.md) にあります。

- [An HTTP API](#an-http-api) と [Calling the program with fetch](#calling-the-program-with-fetch)
- [Setup details](#setup-details)、[Upgrading](#upgrading)、[Secrets need no manifest](#secrets-need-no-manifest)
- [Before / after](#before--after) と [What it fixes](#what-it-fixes)
- [Reports fill themselves](#reports-fill-themselves)
- [Self-healing, with the deviation on the record](#self-healing-with-the-deviation-on-the-record)
- [The compat door](#the-compat-door) と [Try it against your own suite first](#try-it-against-your-own-suite-first)
- [CI runs in depth](#ci-runs-in-depth)
- [The bed has to be tended](#the-bed-has-to-be-tended)

## An HTTP API

**HTTP API**

テスト対象のプログラムは、config の `program` に書きます。
プログラムの起動のしかたを返す関数です。
nukadoko は run ごとに専用の空いているポートでそれを起動し、応答するまで待ち、すべての step の request をそこへ送り、シナリオの後に止めます:

```ts
// nukadoko.config.ts
import { defineConfig } from "nukadoko";

export default defineConfig({
  program: () => ({
    serve: { command: "node src/server.ts" },
    env: { PORT: "{port}" },
  }),
});
```

`{port}` は nukadoko が選んだポートで、プログラムは `PORT` が示すところで待ち受けます。
コマンドは空白で分割され、shell を通さずに動きます。
プログラムは `/` が 2xx で答えた時点で準備ができたとみなされます。
別のパスは `serve.ready` で指定します。
stderr の 1 行が URL と `program.log` を示します。
`program.log` は run の記録の隣にあり、プログラムが出力した内容を持ちます。
既定の `port: "auto"` は、world が起動するときに空いているポートを選びます。
それでも、同時に動く 2 つの run が同じポートを取り合うことはありえます。
そのとき待ち受けられずに終わったサーバは、その world を失敗させます。
もう一方の run のサーバがすでに準備の確認に答えていたなら、world が止まるときに `program-exited` として報告されます。
同じファイルには、`build` と `prepare` のコマンド、run ごとのデータベースのための専用ディレクトリ(`{dir}`)、nukadoko が起動しないサーバのための `url` も書けます。
すべてのフィールドは [docs/spec.ja.md](spec.ja.md#テスト対象のプログラム) の「テスト対象のプログラム」にあります。
このファイルは config と並べて commit します。

ここでの `src/server.ts` は `/greet/<name>` に `Hello, <name>!` というテキストで答えます。
次の feature があるとします:

```gherkin
# features/greet.feature
Feature: greet API

  Scenario: greets by name
    When I request the greeting for "Ada"
    Then the greeting is "Hello, Ada!"
```

When の step とその Then を scaffold するだけで、編集なしでシナリオが動きます。
When の step は Playwright の `request` で request を送るので、`playwright` もインストールしてください:

```sh
npm install -D -E playwright@1.63.0
npx nuka scaffold get-greeting --pattern "I request the greeting for {name:string}" --request "GET /greet/{name}"
npx nuka scaffold greeting-is --pattern "the greeting is {text:string}" --then --from get-greeting.body
```

`get-greeting` は ``request.fetch(`/greet/${name}`, { method: "GET" })`` の呼び出し 1 つで、`status` と `body`(レスポンスのテキスト)を返します。
各 request は step record の `http.jsonl` に記録されます。

`--request "<METHOD> <path>"` は path をプログラムの URL を基準に解決します。
path の中の `{key}` はその args キーの値で、そのまま埋め込まれます。
`--body <key>` は args キー(たとえばその行の `docstring`)を request の data として送ります。
request が読まない値は、置き場所が決まるまで名前を挙げて throw します。
step は `mutates: true` を書きます。
メソッドは書き込みの意味の代わりにすぎないので、`false` にするのは作者です。

## Calling the program with fetch

**fetch でプログラムを呼ぶ**

step は代わりに `fetch` でプログラムを呼ぶこともでき、その場合は何もインストールする必要がありません。
`baseURL` は、上のプログラムから nukadoko が起動したプログラムの URL です:

```ts
// features/steps/get-greeting.ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "GET /greet/<name> from the program under test",
  pattern: "I request the greeting for {name:string}",
  args: z.object({ name: z.string() }),
  returns: z.object({ status: z.number(), message: z.string() }),
  async run({ baseURL }, { name }) {
    const response = await fetch(`${baseURL}/greet/${encodeURIComponent(name)}`);
    const body = (await response.json()) as { message: string };
    return { status: response.status, message: body.message };
  },
});
```

呼び出しは 1 つずつ、リクエスト本文とレスポンス本文とともに step record の `http.jsonl` に記録されます。
`request` の呼び出しと同じです。

Then の step は `nuka scaffold message-is --pattern "the message is {text:string}" --then --from get-greeting.message` で作ります。
`output-says` を `run-greet` から作ったのと同じ方法です。
メッセージには改行がないので、その claim は `view` を必要とせず、scaffold が書いたまま、編集なしで動きます。
feature は次のとおりです:

```gherkin
# features/greet.feature
Feature: greet API

  Scenario: greets by name
    When I request the greeting for "Ada"
    Then the message is "Hello, Ada!"
```

## Setup details

**セットアップの詳細**

`nuka init` は CLI や API のプロジェクトを前提に準備をします。
API の形は [An HTTP API](#an-http-api) にあります。
`.gitignore` に `.nukadoko/` を、`package.json` の scripts に `"test:scenarios": "nuka run"` を追加します。
`.gitignore` にそのディレクトリを無視する行(`.nukadoko`、`/.nukadoko/`、`.nukadoko/**` など)が既にあれば、行は追加しません。
同じ名前の script が既にあれば、そのままにします。
その script が別のものを実行するときは、そのことを stderr に出します。
以後、人も CI も `npm run test:scenarios` の 1 つだけを実行すれば済みます。
対象を渡さない `nuka run` は `featuresDir` を実行します。
その scenario について `nuka check` が報告する内容を報告し、error が 1 つでもあれば何も実行せずに止まります。
`tsconfig.json` の `include` が `features/` や config ファイルを外しているときは、足りないエントリを追加し、ファイルの残りはそのままにします。
コメントや末尾のカンマも、そのまま残ります。
`include` を持たない `tsconfig.json` は、もともとすべてのファイルを検査します。
`compilerOptions` に `allowImportingTsExtensions` も `rewriteRelativeImportExtensions` も無いときは、`"rewriteRelativeImportExtensions": true` を追加します(TypeScript 5.7 以降)。
これで `nuka scaffold --from` が書く `./run-greet.ts` の import を `tsc` が受け付けます。
このオプションは出力するプロジェクトでもしないプロジェクトでも有効で、変わるのは `.ts` ファイルを名指しする import の出力だけです。
`tsconfig.json` が extends するファイルがこのオプションを名指していれば、`init` はそのままにします。
オプションが `extends` を通してだけ届き、そこのどのファイルも名指していないとき、または `init` がそのどれかを読めないときは、`init` はそのことを stderr に書きます。
`tsconfig.json` がどちらのオプションも true にしていないプロジェクトでは、`nuka scaffold --from` は代わりに `./run-greet.js` を書きます。
これは `tsc` がどのオプションの下でも受け付ける名前で、`nuka` は `run-greet.ts` として読み込みます。
そのことは stderr の 1 行の `note:` で伝えます。
`init` が受け付けるフラグは 1 つです。
`--allure` は `allurerc.mjs` を書き、`nuka report` が Allure の結果を書くディレクトリを作ります([Reports fill themselves](#reports-fill-themselves) を参照)。
`init` は常に `.env`、`.env.*`、`!.env.example` を `.gitignore` に追加します。
`.env` を意図してコミットするプロジェクトでは、その行を削除します。
`nuka` は config があるディレクトリ、workspace ならそのパッケージで実行します。
config が無い場所で実行したコマンドはそのことを stderr に書き、親ディレクトリに config があればそれを示し、そのとき `nuka scaffold` は書き込みを拒否します。

Node は step ファイルの型を除去して実行するので、2 種類の TypeScript は読み込めません。
実行時の振る舞いを持つ構文(`enum`、`namespace`、コンストラクタのパラメータプロパティ)は拒否され、`nuka check` はその行に `step-file-import-failed` を報告し、書き換え方を示します。
型でしかない名前を `type` なしで import すると import として残り、Node の "does not provide an export named" エラーで失敗します。
`IWorldOptions` のように nukadoko 自身が export する型なら、finding は `import type` と書くよう伝えます。
`compilerOptions` に `"erasableSyntaxOnly": true` と `"verbatimModuleSyntax": true` を設定すると、`nuka` を実行する前に `tsc` が両方を報告します。
`.ts` ファイルの隣の `.js` ファイルを名指しする import(`run-greet.ts` に対する `./run-greet.js`)は、`nuka` の下では引き続き読み込めます。
`nuka` が一方を他方に対応付けるからです。
素の `node` は対応付けないので、scaffold は `.ts` の名前を書きます。

nukadoko は `dist/` と並べて TypeScript のソースも同梱しているため、stack trace は実際のコードを指します。
`node_modules` を読む agent は、型だけでなく「なぜそう動くか」も確認できます。

既存の `package.json` に `"type": "module"` が無い場合、そのプロジェクトは CommonJS を使います。
ふつうの `npm init -y` もこの形を書きます。
`nuka init` はそれでも動きます。
`nukadoko.config.ts` の代わりに `nukadoko.config.mts` を書き、step ファイルも `.mts` にする必要があることを 1 行で伝えます。
nukadoko は ESM だけをサポートします。
このようなプロジェクトでは、Node はふつうの `.ts` ファイルをまず CommonJS として読み、読み込むたびに警告を出して ES module として解析し直します。
`"type": "commonjs"` のもとでは解析し直さず、そのファイルは import に失敗します。

<details>
<summary>まだ `package.json` がありませんか(Rails、Django など Node 以外のリポジトリ)?</summary>

先に作成してください。
`npm init -y` は避けてください。
既存の `README.md` の最初の行を `description` に、ディレクトリ名を `name` にコピーしてしまいます。
最小限を手で書くほうが確実です:

```json
{ "private": true, "type": "module" }
```

`"type": "module"` を付けると、生成されるファイルはすべて `.ts` のままになり、上の 2 つの経路のうち簡単な方を使えます。
省略してもサポートされます(上の CommonJS の段落を参照)。
ただし、このようなプロジェクトで手で書いた `nukadoko.config.ts` は、警告付きで読み込まれます。
`"type": "commonjs"` のもとでは読み込みに失敗します。
そのエラーはそのファイルと原因を名指しし、`nukadoko.config.mts` へのリネームを案内します。
代わりに `nuka init` は `nukadoko.config.mts` を書きます。
`.nukadoko/` を自分で `.gitignore` に追加する必要はありません。
`nuka init` が追加します。
`.env` と `.env.*` も追加し、`.env.example` は追跡されたままにします。
nukadoko が撮るスクリーンショットは、ページが表示するロードした secret を覆います。
ただし state directory の中の trace は redact されないため、state directory には機密データが含まれます。

</details>

## Upgrading

**アップグレード**

`npm install -D nukadoko@latest` を使ってください。
インストール時に npm はキャレット範囲を書きます。
メジャーバージョンが 0 の間は、キャレットが minor も固定します(`^0.14.1` が許すのは `0.14.x` だけで、`0.0.x` では patch まで固定します)。
そのため `npm update` だけでは最初に入れた minor を超えません。
0.x の間はどのリリースでも public API が変わり得ます。
範囲指定に頼らず、[changelog](../CHANGELOG.md) を読んでください。
破壊的変更のあとに実際に何を直すかは、[docs/upgrading.ja.md](upgrading.ja.md) を参照してください。

## Secrets need no manifest

**secret に manifest は要らない**

既存の env file を `envFiles` に指定すると、git が分類します。
追跡されていないファイルは secret source となり、そこで定義された各値はログと step record から伏せられます。
追跡されているファイルは、working tree が HEAD と一致するあいだ平文の設定であり、変更されません。
追跡されているファイルに未コミットの変更があると、その値も同じように伏せられます。
manifest も、別のファイルへの手作業によるコピーも必要ありません。

## Before / after

**移行前 / 移行後**

regex のグルーコードを型付きの step に昇格させる例です。
feature 行のテキスト自体は変わりません。
変わるのはその背後にある step の定義だけです。

Before(cucumber-js、位置キャプチャ、型なし、World への stash):
World は、cucumber-js があらゆる step に与える、scenario ごとの `this` オブジェクトです。

```ts
// features/steps/project.ts (cucumber-js)
import { Given } from "@cucumber/cucumber";

Given("a project {string} exists", async function (name: string) {
  const res = await this.request.post("/projects", { data: { name } });
  const body = await res.json();
  this.project = body; // stashed on World — no schema, no type
});
```

After(`defineStep`、named capture、zod、step record 付き):

```ts
// features/steps/create-project.ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "a project {name:string} exists",
  description: "Create a project and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  mutates: true,
  async run({ request }, args) {
    const res = await request.post("/projects", { data: args });
    return res.json();
  },
});
```

- named capture(`{name:string}`)は、値を名前で `args.name` に結び付けます。
  位置キャプチャでは、同じ型の値 2 つを pattern 内で入れ替えると、どちらの値がどこに入るかが黙って入れ替わります。
  `nuka check` は、それが起きる前に、裸の `{string}` もエラーとして検出します。
- `args` と `returns` は、実行境界でバリデーションされる zod のスキーマです。
  step record の `result` は、step が返しただけのものではなく、ツールがバリデーション済みのものです。
  上の `z` は nukadoko 自身から来るので、zod を別途インストールする必要はありません。
  自分のプロジェクトですでに zod を使っていて、そちらのスキーマを渡す場合は、そのスキーマが zod 4 である必要があります。
- 上の `request`(そして browser の step 向けの `page`)は、`run` の第一引数である fixture bag から直接分割代入されたものです。
  step が実際に分割代入した名前だけが構築されるため、`page` を一度も名指ししない step はブラウザを起動しません(そうした step を持たないプロジェクトは、[Install](../README.ja.md#install) のとおり Playwright そのものをインストールしません)。
  どちらも返すのは Playwright 自身の `APIRequestContext` と `Page` のオブジェクトであり、nukadoko 独自のラッパーではありません。
  そのため既存の Playwright の知識とヘルパーはそのまま持ち込めます。
- 上の `request.post("/projects", ...)` は、その相対パスを、config の `program` が起動するか名指すプログラムの URL に対して解決します([An HTTP API](#an-http-api))。
  プログラムがなければ、絶対 URL しか通りません。
- `nuka do create-project --args '{"name":"acme"}'` は、この step だけを実行して step record を出力します。
  この record は agent の探索ループを構成する単位であり、事前の準備は不要です。

## What it fixes

**何を直すのか**

どの行も、文と実行のあいだの対応づけがかつて緩んでいた場所です。
cucumber-js を引き合いに出しているのは、そこが最もなじみ深い場所だからであって、それだけがこの緩みを持つ層だからではありません。

| The failure | What nukadoko does about it |
|---|---|
| 重複する step(どれが一致したか分からない) | `nuka check` は、何かが実行される前に、同じテキストが 2 回登録されている **duplicate patterns** と、feature の 1 行に異なる 2 つの pattern がどちらも一致し得る **ambiguous steps** を報告します |
| `this.foo`(型のない袋) | step は `returns` スキーマに対して値を返し、後続の step はそのうち 1 つのキーを名前で読むために `from` を宣言します。この依存関係は diff 上で見える import として現れ、読んだ事実は読み手側 step の step record に記録され、束縛の順序が壊れていれば `nuka check` が実行前に検出します(参照: [step の連鎖](spec.ja.md#step-の連鎖)) |
| `passed` としか言わない報告 | あらゆる実行が、バリデーション済みの result、ツール自身が記録した HTTP の呼び出しとその本文、プロセス、ファイル、見えたが計測できなかった操作、evidence、environment、target version を記録した step record を書きます |
| 実行時に見つかる undefined な step | `nuka check <feature>` はそれらを実行前に静的に検出して失敗し、何にも一致しなかったテキストの名前を挙げます |
| コードで判定する、あるいは黙って操作する `Then` | 型付きの `Then` はコードではなく claim を宣言します。どの値を読み、どう比べ、expected の値がどこから来るか(step が別の出どころを述べない限り文)です。比べるのは nukadoko で、record と run サマリは両方の値を名指しします。`nuka check` は、実行する step に結び付いた `Then` と、`Given` や `When` に結び付いた claim step を拒否します([Claims](spec.md#claims) を参照)。 |
| 機能があってもなくても通る scenario | environment はプログラムのスイッチを `conditions` として宣言し、`@with:<switch>` の tag を付けた scenario は、スイッチが切れているところでも、run を赤にしない対照として走ります。そこで Then が 2 回の実行で同じ行で失敗すれば、行は `proven` になります。対照が通った行は `held` のままで、run サマリの表がどちらなのかを示します([断定](spec.ja.md#断定) を参照) |
| 黙って状態を変える step | `mutates` は nukadoko が信頼する宣言であり、計測から導き直す数値ではありません。`mutates: true` を宣言した step は、read-only な environment では実行前に拒否されます。実際に何が起きたかは、レビューのためにいまも step record に記録されます。 |

最後の項目には、正確な説明が必要です。
このツールはかつて、約束ではなく回数に対して失敗していました。
この挙動は、計測が支えられない主張をしていました。
その回数は HTTP メソッドを書き込みのプロキシとして使っていました。
このプロキシは、GraphQL、RPC-over-POST、純粋な読み取りを POST 上に実装するベンダーの query API では破綻します。
そうした API を呼ぶ正直な `mutates: false` の step も、書き込みに見えます。
一般的な HTTP レイヤーのルールでは、その呼び出しと本物の書き込みを区別できません。
そこで nukadoko は宣言を信頼し、メソッドから書き込みを推測することはしません。
step record は、計測した各 request をメソッド、URL、status、本文とともに、断定ではなく事実として残します。
計測できなかったものは、推測せずにそうと名前を挙げます。

## Reports fill themselves

**レポートはひとりでに埋まる**

従来型の Cucumber の実行は、チームが自分で仕込んだ evidence だけをレポートに映します。
各プロジェクトが、trace やスクリーンショットのための hook の boilerplate を書いて保守します。
[Allure](https://allurereport.org/) はテストレポートのダッシュボードで、nukadoko はその形式で結果を書くだけで、HTML 自体は決してレンダリングしません。
`nuka report --format allure` は、追加の設定なしで、終わった run のあらゆる step record からレポートを満たします。
バリデーション済みの result、trace、HTTP log、environment、version を追加します。
そのうち、各 step のバリデーション済み result は、従来型の Cucumber ではレポート側から追加できません。
Cucumber が step の返り値を捨てるためです。

各 step の下には、絶対時刻から組み立てられた、その内部で何が起きたかのタイムラインが置かれます。
到達した段階、それぞれの待ちの実際の所要時間と試行回数、そして assertion を含めて実行された Playwright の呼び出しのすべてです。
1 回の試行と 40 回の試行では直し方が正反対になりますが、それを見分けられるのはレポートの中でここだけです。
`Then` の各 claim は、タイムラインの後にそれ自身の child step として続きます。
名前はその claim の行で、passed か failed になり、両方の値とそれぞれの出どころが parameter に入ります。
ページ自身が述べたこと(console error、捕捉されないエラー、失敗したリクエスト)の件数が step のそばに置かれるので、ページが 3 件の捕捉されないエラーを投げながら通った step は、誰も attachment を開かなくてもそれを語ります。
添付される trace はその step 自身のものであり scenario 全体のものではないため、失敗した step はさがし回らずに直接開けます。
同じ `trace.zip` は step record の下にも単体で置かれており、Allure を介さずに `npx playwright show-trace <evidence.dir>/trace.zip` で直接開けます。
step record も全文がそのまま添付され、それがこの一覧を古びさせずにいる理由です。
step record が後から何を得ても、2 つ目の対応表を覚える必要なくレポートに届きます。

`nuka report --format messages` は同じ run の cucumber-messages(NDJSON)ストリームを書くので、移行するチームの既存フォーマッタと JUnit ベースの CI をそのまま動かし続けます。
これは単なる主張ではなく、自前のストリームを `@cucumber/junit-xml-formatter` に通して確認済みです。
この formatter は test case の名前を scenario から付けるので、2 つの environment で走らせた素の Scenario は、そこでは同じ名前の 2 つの test case になります。
対照(condition が成り立たないところで走らせた scenario)はストリームから外れるので、JUnit は green の run を green と読みます。
ただし赤の run をいつも赤と読むわけではありません。
`--base` のもとでの `unproven` や `moved` の行は、そこでは失敗した test case にならないので、`nuka run` の終了コードでゲートします。
Allure は対照を `<scenario> (control)` という名前で、走った結果の状態のまま残します。
[Allure results](spec.ja.md#allure-results) と [Messages stream](spec.ja.md#messages-stream) を参照してください。

`nuka run` はどちらも書きません。
`nuka report` が run の後に、run ディレクトリだけから描き出します。
そのため CI のマシンから持ち出した run ディレクトリも描き出せ、1 つの run を別の形式で描き直すこともできます。

```sh
npx nuka run
npx nuka report --format allure                        # .nukadoko/export/allure-results
npx nuka report --format messages --out messages.ndjson
npx nuka report .nukadoko/runs/<run_id> --format allure --out reports/allure
```

run ディレクトリを渡さなければ、最新の run を描き出します。
`--out` は出力先を移します。
渡さなければ、Allure の結果は `.nukadoko/export/allure-results` へ、ほかの 2 つの形式は stdout へ出ます。

nukadoko が書くのは結果であって HTML ではないため、それを描画するのは Allure 3 の CLI です(`npm i -g allure`、または以下のように `npx allure`)。

```sh
R=.nukadoko/export/allure-results
npx allure watch $R --output .nukadoko/allure-report     # live, re-renders as a run writes
npx allure generate $R --output .nukadoko/allure-report
npx allure open .nukadoko/allure-report                  # serve one already generated
```

生成したレポートの `index.html` は、`file://` では直接開けません。
レポートの SPA は読み込み時に `widgets/*.json` を fetch しますが、`file://` はそれを配信できません。
それでもヘッダとフッタは描画されるため、壊れたレポートが一見すると正常に見えます。
この問題は、CI からレポートの artifact をダウンロードし、手元で `index.html` を開いたときに起きます。
代わりに、上の `npx allure open` または `npx allure watch` でレポートを配信します。

`nuka init --allure` はプロジェクトの root に `allurerc.mjs` を書き出します(Allure が自動検出するいずれかの名前で既にあれば、書かずにその旨を伝えます)。
これを置かないと、nukadoko のあらゆる失敗は Allure 3 に組み込まれた 1 つの category「Product errors」に落ちてしまい、9 個の `error.kind` のどれにも分類されません。
`init` を使わないプロジェクトは、[examples/allure/allurerc.mjs](https://github.com/meganemura/nukadoko/blob/main/typescript/examples/allure/allurerc.mjs) を手でコピーして置くこともできます。

各コマンドに `--output` を渡してください。
Allure はこれを省くとカレントディレクトリの `allure-report/` を既定にし、`watch` もそこへ書き込みます。
つまり既定のままでは、レポートを見ただけで、追跡もされず ignore もされていない生成物がリポジトリのルートに残ります。
`.nukadoko/` の下へ出せば、`nuka init` がすでに gitignore に入れた場所に収まります。

反復中は `watch` を使います。
片方の端末で動かしたまま、もう片方で `nuka run` に続けて `nuka report --format allure` を実行します。
描き出した結果が届くと、レポートが更新されます。
待ち受けるポートはランダムで、`--port` で指定できます。
ブラウザを開くのは `--open` を渡したときだけです。
`nuka init --allure` は `.nukadoko/export/allure-results/` を作るため、最初に描き出すより前に `watch` を開始できます。

同じ run を描き直すと、前回その run を描き出したときに書いたものが置き換わるので、ディレクトリには各 scenario が 1 つずつだけ残ります。
run のファイルは、その run が最新 `retention.runs` 回(既定 20)より古くなった時点で run と一緒に消えるので、レポートに載るのは多くてもその回数ぶんの run です。
`nuka clean` は record とあわせて、このディレクトリを一度に空にします。

## Self-healing, with the deviation on the record

**自己修復、ただし逸脱は記録に残す**

スクリプト化された scenario が壊れるのは、アプリが変わったからであり、テストが間違っていたからではありません。
nukadoko が作られているのは、この修復のループのためです。

1. agent は `nuka do` を使い、1 step ずつ各 step record を読んで次の呼び出しを決めながら、目標を適応的に再実行します。
   壊れた scenario をそのまま再生しているのではなく、いま何が通用するのかを見つけ出しているのです。
2. それらの step record は、実際にうまくいった手順を記録します。
   それは定義上、スクリプト化されたものから逸脱しています。
   step record は修復の物語であり、証明ではありません。
   agent は PR の中で、それらをまさにその物語として引用します。
3. PR は型付き step または feature ファイルを更新し、その証明となるのは修復された scenario が green で通ることです。
   すなわち scenario の記録とその step record であり、他のどんな変更とも同じようにレビューされます。

手順 2 が中心です。
**監査証跡のない self-healing では、スイートが気づかないうちに何もテストしなくなります。**
アプリの現在の挙動に合わせて書き換えられた scenario は通りますが、以前の確認が消えたことは誰にも見えません。
ここでは、レビュアーが逸脱の記録を読めます。
証明は常に scenario を通り、ad-hoc な一連の呼び出しを通りません。

nukadoko の貢献は、すべての段階が記録を残すことです。
執筆は agent のワークフロー(README の [Skills for coding agents](../README.ja.md#skills-for-coding-agents) で扱う、同梱の skill)であり、エンジンの魔法ではありません。
詳しくは [Self-healing, audited](spec.ja.md#self-healing監査付き) を参照してください。

このループは、スイートが空洞化する別の経路を**捕まえられません**。
scenario を保ったまま、その `Then` が弱くなることがあります。
step record は実行が何をしたかを示し、claim は `Then` が何を比べたかを示します。
しかしどちらも、その比較がいまも受け入れ基準の言うとおりの意味を持つかは示せません。
この問題はレビューで捕まえる必要があり、[What this does not do](../README.ja.md#what-this-does-not-do) でも説明しています。

## The compat door

**compat の扉**

この節より前のどれも、既存のスイートがあることを前提にしていません。
この節は、それがある場合のためのものです。

既存の Cucumber + Playwright スイートを移行するには、import を `@cucumber/cucumber` から `nukadoko/compat` に切り替えます。
同じ pattern の構文、hooks、World はそのまま動き、その間に nukadoko の harness が step record の計測を始めます。
World のサブクラスは `this.page` と `this.request` に代入できます。
そのような page には trace も page のログもありません。
ただし、そのような `this.request` を通して step から送ったリクエストは、`http.jsonl` に記録されます。
その後は各 step を個別に `defineStep` へ昇格できるため、一部だけを昇格したスイートも通り続けます。

扉は入口であり、行き先ではありません。
compat の step は、最初の run から status と時間を持つ step record を得ます。
evidence と、page の `http.jsonl` の行が付くのは、その glue がブラウザや request を `this.openPage()` / `this.openRequest()` で開くようにしてからです([docs/migration.ja.md](migration.ja.md) の measured upgrade)。
ただし、nukadoko は return 値を捨て、step record には `result: null` が入ります。
バリデーション済みの result が必要な機能は使えません。
`nuka check` には feature と比較する契約がなく、`from` は依存関係を宣言できません。
green の run サマリが確認するのは step の実行だけであり、宣言された契約が保たれたことではありません。
これらの制限が、各 step を昇格させる理由です。

import を元に戻せば、ただの cucumber-js スイートに戻ります。
これは変わらない設計上の規則です(compat の資産は、切り替えにも部分的な移行にも耐えなければなりません)。
その役目は、nukadoko を試すコストを、大きな決断ではなく編集 1 つ分にすることです。
それは戦略を組み立てるための性質ではありません。
`defineStep` に昇格させた step には、切り替えて戻す import がありません: `run` は Playwright 自身のオブジェクトに対して書かれているため body は移りますが、そのスキーマとその上に組まれたものは移らず、ここには元に戻す手段は何もありません(手作業での道筋は docs/migration.ja.md の「戻り道」に書いてあります)。

移行のコストは、推測ではなく計測しました。
監査では、公開されている 8 本の cucumber-js スイートから glue を読み、この扉と比較しましたが、スイートは実行しませんでした。
監査時には、**import の変更だけで通ったものはありませんでした**。
見つかった障害を修正した後、8 本のうち 2 本では拒否される glue がなくなりました。
残る 6 本は、先に短い機械的な準備が必要です。
各障害は import 時または最初の run で失敗し、挙動を黙って変えません。

それらのスイートのうち 3 本は、その後 [nukadoko-lab](https://github.com/meganemura/nukadoko-lab) で、読むのではなく実際に走らせました。
これは固定された corpus を複製し、import を 1 つ書き換え、その結果に対して `nuka run` を実行するものです。
1 本は import だけで通りました。
残る 2 本のうち、1 本はいまは通ります。
step discovery が当初 `.ts` しか読んでいなかったため、素の `.js` で書かれた glue が見つからないままでした。
0.1.0 でその対象が `.ts`/`.mts`/`.js`/`.mjs` に広がり、それ以降 lab が再計測したどの版でもそのスイートは通っています。
もう 1 本はいまも失敗します。
その glue の外にあるファイルが素の `require()` を呼んでおり、discovery はスイートの feature ディレクトリ配下のすべてのファイルを歩くので、step を登録するものだけを見るわけではありません。
そのため import の途中で例外が投げられ、discovery ごと中断します。
`nuka check` はこの失敗を許容してそのファイルを名指ししますが、`run` はフェイルファストで回復しません。
lab を最後に再実行したのは 2026-08-16 です。
glue をテキストとして読むことは、glue の中に見える障害を見つけました。
それを実行することは、見えていなかった障害を 2 つ見つけました。

障害の 1 つは先に名指ししておく価値があります。
それは通過ではなく go/no-go だからです。
**CommonJS のスイートは、この扉をまったく使えません。**
`require("nukadoko/compat")` は、nukadoko が ESM 専用であるため、端的に失敗します。
つまり CommonJS のスイートには、他の何より先にモジュール形式の変更が必要です。
監査した 8 本のうち 2 本は、全体が CommonJS でした。
これはファイル拡張子の話ではなく、モジュール形式の話です。
`.js` や `.mjs` の glue は他と同じように読まれ、`.cjs` や `.cts` のファイルは、後になって何も定義していない step として現れる代わりに、`nuka check` がそれを名指しします。

手順を追ったガイド(監査結果を収録)は [docs/migration.ja.md](migration.ja.md) を、最後まで動く実例は [examples/migration](https://github.com/meganemura/nukadoko/tree/main/typescript/examples/migration) を参照してください。

cucumber も Gherkin も無く、Playwright Test だけを使っている場合は別の扉になります。
[docs/migration-playwright-test.ja.md](migration-playwright-test.ja.md) がその道筋です。
スイートはいまの場所に残り、自分の runner を使い続けます。
移るのは操作の実装だけで、spec と typed step の両方がその関数を呼びます。

## Try it against your own suite first

**まず自分のスイートで試す**

何かを移行しなくても、これが合うかどうかは分かります。
agent を自分のリポジトリに向けて、以下のプロンプトを渡してください。
agent は、あなたのスイートの形、移行のコスト、何がうまくいかない可能性があるかを報告します。

<details>
<summary>評価プロンプト(自分のリポジトリで動く agent に貼り付けてください)</summary>

```
You are evaluating whether to adopt nukadoko (github.com/meganemura/nukadoko)
for this project's end-to-end / acceptance tests.

1. Read nukadoko's README and its full design spec, docs/spec.md, to
   understand what it actually does today versus what is only designed.
2. Survey this project's existing E2E / acceptance test assets: feature
   files (or equivalent scenarios), the glue/step code behind them, and how
   CI runs them.
3. Report back under exactly these five headings, in this order:

1. Current state (what test suite exists today): scope, coverage, what
   executes it.
2. Fit (how typed steps + step records would change the way an agent runs
   this suite's checks): which flows become vocabulary, and what the
   explore-execute-decide loop looks like concretely here.
3. First three migration moves: the first commands to run and the first
   slice of steps to bind (e.g. `nuka init`, binding an initial slice of
   steps, promoting the hottest existing step to a typed one).
4. Risks and costs: an estimate of vocabulary size (how many distinct
   typed steps this suite would need), how much of the existing `Then`
   usage only reads and compares (a typed `Then` declares claims, and its
   sentence states the expected value) versus acts or keeps the expected
   value in code, whether the suite is CommonJS, and where secrets currently live
   relative to where nukadoko expects them.
5. Verdict: adopt / trial / not-yet, with the reasoning.

Do not guess at nukadoko internals beyond what its README and docs/spec.md
state. If something is unclear, not yet implemented, or you don't have
access to a document you need, say so rather than assuming.
```

</details>

## CI runs in depth

**CI の詳細**

この節は、README の [Running this in CI](../README.ja.md#running-this-in-ci) の続きです。
ゲート全体を走らせる 1 つの step の後の話をします。

`nuka run` は自身の進捗と書き込み先も、走りながら stderr に出力します。
stdout には、求めたときだけ出力されます。
`nuka run --records` は、scenario が終わるたびに、その scenario の `run.json` のエントリを 1 行 1 件の JSON として stdout に出力します。
`nuka run --json` は、代わりに `run.json` そのものを出力します。
それはすべての `--json` が出力する envelope で、`findings` の隣に run のフィールドが入ります。
そこにはコミットと作業ツリーが dirty だったかどうか、実行した各 environment、`:line` の対象か `--tag` が run を `partial` にしたかどうか、件数、断定の表(受け入れ基準ごとに 1 行、environment ごとに 1 つのセルで、各行は `held`、`proven`、`failed` のどれか)、各 scenario の step(行、status、step record、claim step ならその claim、失敗ならそのエラー、読んだ結果、再実行のコマンド)が入ります。
`--json` のときは stderr は空で、警告は文書の中の finding になるので、エージェントのシェルに見えるのはその文書だけです。
`run.json` と step record は、フラグにかかわらず run 自身のディレクトリ `.nukadoko/runs/<run_id>/` に書かれ、run サマリは `run.json` だけから描画されます。
stdout や stderr が端末かどうかで変わる出力はありません。
失敗した step は、進捗行の下にエラーの 1 行目と step record のパスを出力します。
そのため、CI のログだけで失敗の理由が分かります。
失敗した step が、プログラムが 0 以外で終わった step から値を読んでいたときは、その 2 行の間に `used` 行が入ります。
その行は、その step、exit code、stderr の最初の行を示します。
空の stdout に対して claim した Then は、たいていそこで成り立たなくなっています。
サマリの後では、失敗した各 scenario が `scenario-failed` の finding になり、その `do:` 行が scenario を再実行します。

```text
  step 2/2  failed  0.0s  the sum is 5
      claim broken: 4 (from:add@4.sum) equal 5 (sentence:expected)
      record  .nukadoko/runs/<run_id>/steps/<id>
...
failed	scenario-failed	features/sum.feature:3	two and two: claim broken: 4 (from:add@4.sum) equal 5 (sentence:expected)
  do: nuka run features/sum.feature:3
```

同じ事実は、ログではなく人のために書かれた Markdown の run サマリにも入ります。
毎回の run で `.nukadoko/runs/<run_id>/summary.md` に書かれ、`$GITHUB_STEP_SUMMARY` が設定されていればそこに追記されます。
終わった run であれば `nuka report --format markdown` が同じものをもう一度出し、PR のコメント step 向けには `--out <path>` で書きます。
その 1 行目は `<!-- nukadoko:run -->` なので、CI の step は前の push で投稿したコメントを更新できます。

**記録を置き換える retry は恒久的にスコープ外であり、「いまはまだ」ではありません。**
green な scenario は、その待ちが正しい場所に置かれている証拠には一切なりません。
scenario が必要としたあらゆる待ちは、もっと下流のどこかに偶然置かれていても供給され得たものであり、それらを一切通らない経路だけが、待ちが本来どこに属するかを示せます([Design](spec.ja.md) を参照)。
step record の `polls` フィールドは、すでにそれを正直に保っています。
即座に返った 1 回の試行と、20 秒待ち続けた 40 回の試行とを区別します。
step 全体を通るまで再実行し、勝った試行だけを残す retry は、green な実行を買うためにその区別を捨ててしまいます。
ここでスコープ外とされているのはまさにこの形です。
Playwright 自身の `retries` と `testInfo.retry` が取る形であり、最後の試行だけが最終レポートに残ります。
scenario を複数回走らせながら、すべての試行それぞれの記録を残し、どの試行が通ったかを名指しすることは、これとは別の形です。
この形によって、記録が語れない事実を語ることにはなりません。
この形をスコープ外にしているわけではありません。
`nuka run --repeat <n>` がそれを出荷しています(このセクションの末尾を参照)。

記録を消す形の retry をスコープ外にしても、それが覆い隠していたはずの flake が消えるわけではありません。
サードパーティのスクリプトや CI ランナー上の資源競合は、待ちが正しく置かれている scenario でも失敗させ得ます。
retry が無ければ、その失敗はそのまま run を赤くします。
`nuka run` を merge のゲートに置くスイートには、その失敗を人間がトリアージする必要があります。
直すべきものが常に「待ちの場所が間違っていた」だとは限らないからです。

`nuka run --concurrency <n>` は feature ファイルを並列に実行し、既定の並行度は 1 です。
フル run の壁時計は、並行度を上げるほど短くなり、機に worker をもう 1 つ足す余地が無くなったところで止まります。
どこで止まるかは推測より実測が要ります。
10 コアの機では worker 4 個が 8 個に勝ちました。
配る単位は feature ファイル全体なので、1 つのファイルの中の作業は分割できません。
少数の大きなファイルでできたスイートは、同じ scenario が多数のファイルに散っている場合より得が小さくなります。
1 つのスイートを複数の invocation に分けるシャーディングは、record が複数の run id にまたがり、1 つの run サマリでは記述できなくなるため利用できません。
並列実行によって `nuka run` は速くなりましたが、ブラウザを起動するため、依然としてコストの高いゲートです。
したがって、README の [Running this in CI](../README.ja.md#running-this-in-ci) で述べた分け方は変わりません。
スイートが大きくなっても PR ゲートを速く保つため、あらゆる PR で `nuka check` を実行し、merge、deploy、夜間の build で `nuka run` を実行します。

`nuka run --repeat <n>` は、選ばれたすべての scenario を 1 回の呼び出しの中で `n` 回実行します。
数回に 1 回だけ再現する失敗のためのものです。
各実行は 1 つの run id の下でそれぞれ自分の record になります。
1 回でも失敗した scenario は、summary の後に `<passed> of <n> passed` の形で集計されます。

`nuka run --order shuffled` は、同じ選択を seed が名指す順序で実行します。
前の scenario がプログラムに残したデータのおかげで通る scenario のためのものです。
feature ファイルを並べ、次に各ファイルの scenario を並べるので、どの `--concurrency` でもファイルは分かれません。
seed は stderr、`run.json`、サマリに出て、`--order shuffled:<seed>` がその順序をもう一度実行します。
失敗した scenario の `do:` 行はその前に走った scenario を名指すので、順序への依存なら、単独で走らせれば通る場合でも、その行でもう一度失敗します。
既定はこれまでどおりファイル順です。

`nuka run --env a --env b` は、選ばれたすべての scenario を各 environment で 1 回ずつ、1 つの run id の 1 回の run の中で実行します。
まず `a` ですべてを実行し、次に `b` ですべてを実行します。
それぞれの environment が、自分の env file、secret、version の probe、プログラム、BeforeAll と AfterAll、process スコープの fixture を持ちます。
`run.json` は断定の表を持ちます。
受け入れ基準ごとに 1 行、environment ごとに 1 つのセルで、サマリはこの表で始まります。
environment はプログラムのスイッチを `conditions` として宣言でき、`--env` の無い run はそれを宣言するすべての environment、またはプログラムの `defaultEnvironments` が名指す environment を走らせます:

```ts
env: { BANNER: "{condition.banner}" },
environments: {
  "banner-off": { conditions: { banner: false } },
  "banner-on": { conditions: { banner: true } },
},
```

`@with:banner` の tag を付けた scenario は、`banner-on` では必須、`banner-off` では対照です。
対照が run を赤にすることはありません。
その Then が 2 回の実行で同じ行で失敗すれば(`--proof-runs`)、行は `proven` です。
scenario がスイッチの 2 つの側を見分けるということです。
通れば行は `held` で、それが読むべき行です。
Then はスイッチが変えるものを見ていません。
必須のセルが通らなければ、行は `failed` で、終了コードは 1 です。
`--env default` はトップレベルの environment を、`run.json` が名付けるとおりに名指すので、`--env default --env staging` は両方を実行します。
environment はそれでもプログラムの設定にすぎません。
`a` と `b` で何が違うかはそれぞれのフィールドが決めます。
`conditions` は何も設定せず、nukadoko はそれをプログラムと照らし合わせません。
`{condition.banner}` は environment が宣言する側をプログラムに渡すので、2 つは食い違いません。

`nuka run --base <git ref>` は、`origin/main` など、ref が名指すコミットと各受け入れ基準を比べ、行が必要とするところに 2 つの world を加えます。
受け入れ基準はその feature ファイルと名前で、その中身は人が承認したもの(step、Examples の行、condition の tag)なので、名前や tag を変えた scenario は `unchanged` のままです。
`new` か `changed` の受け入れ基準は `base` の world、つまり head の受け入れ基準と step のもとでの基点のコードでも走ります。
その Then がそこで 2 回の実行のそれぞれで失敗すれば、行は `proven` です。
それを示すものが無ければ行は `unproven` で、`@held` は基点がすでにその振る舞いを持っていたと述べます。
対応づけ(features ディレクトリの下の step ファイルや補助、config の fixture や parameter type、environment の condition)が変わったときは、`unchanged` の受け入れ基準が `old` の world、つまり基点の受け入れ基準と step のもとでの head のコードでも走り、そこで通らなければなりません。
通らなければ行は `moved` です。
承認された文が、もう承認されたときの意味ではないということです。
各 world は run ディレクトリの下の tree で、その tree のプログラムから build して走り、パッケージは head のプロジェクトから解決します。
`failed`、`unproven`、`moved` の行があれば終了コードは 1 で、`removed` の行は消えた受け入れ基準を引用します。
浅いクローンでは先に基点を取ってきます。
拒否がそのコマンドを名指します。

## The bed has to be tended

**床には手入れが要る**

nukadoko は、きゅうりを漬ける発酵させた米糠の床です。
それは生きており、毎日手入れをすれば熟成し、放っておけば死にます。
このツールが、あるスイートの step 定義について主張しているのはまさにそれです(書いて終わりの資産ではなく、生きた培養菌だということ)。
そして、これは単に名前についての言い回しにとどまりません。

`nuka check` が問うのは、プロジェクトがいますぐ run できるかであり、あらゆる run の前に読まれることを意図しています。
その注記が問うのは別の問い、すなわちこれのどこかが腐りつつあるかです。
詳しくは [check と注記](spec.ja.md#check-と注記) を参照してください。
何にも行使されない `from` 宣言。
どの feature も結び付けない pattern。
description のないスキーマフィールドは、ファイルを見る人にはそれで問題なく読めても、2 つの step のどちらかを選ぶ agent には何も伝えません。
そのどれも run を止めないので、注記は exit code を変えません。
注記でゲートを掛けたいジョブは、その code を `nuka check --fail-on` で名指します。
注記を報告するのは対象を指定しない check だけです。
step が結び付いているかどうかは、プロジェクトがスキャンするすべての feature で決まるからです。

---

English: [guide.md](guide.md)
