# nukadoko 仕様

> nukadoko(あなたの Gherkin のための生きたぬか床): 型付きの step、receipt、そして agent-first な CLI。

> 原文は spec.md。相違があれば原文が正。

Status: M1(engine core)実装済み(`steps`/`describe`/`do`/`run`/`check`/`init`/`scaffold`、session、environment、secret)。
Pre-0.1 で、実世界での検証ゲート(後述、実装ノート)はまだこれからであり、M2 以降(compat、Allure、sign-off)は設計としてのみ存在します。

## nukadoko とは

nukadoko は Gherkin を実行する agent-first のエンジンです。
人間は耐久性のある成果物(feature ファイル、型付き step の定義、sign-off の記録)を書きレビューし、agent がそれらを実行します。
実行系はすべて agent の試行錯誤ループのために最適化されており、あらゆる step が型付きの契約を持ち、あらゆる step が CLI から単独で実行でき、あらゆる実行が agent には偽造できない receipt を残します。

Agent-first は設計上の制約であり、スローガンではありません。
agent は、介助なしにループ全体を完了できなければなりません。
語彙を発見し(`nuka steps --json`)、契約を読み(`nuka describe`、スキーマは JSON Schema として)、1 つの step を実行し(`nuka do`、receipt は stdout に、意味のある exit code とともに)、バリデーション済みの結果を読み、次の呼び出しを決めます。
語彙に操作が欠けているときは、agent が新しい step を scaffold して実装し、人間がその PR をレビューします。
あらゆるインターフェースは機械可読な出力を優先し、人間にとっての見やすさは Allure に委ねられます。

ぬか床とは、きゅうりを漬物に変える米ぬかの発酵床のことです。
ぬか床は生きており、毎日手入れをすれば熟成し、放っておけば死にます。
nukadoko が step 定義について主張しているのはまさにこれで(step 定義は書いて終わりのテスト資産ではなく生きた培養菌である)、それを日々手入れするのが agent です。

nukadoko は意図的に、所有する範囲を最小限にとどめています:

| 関心事 | 担当 |
|---|---|
| Gherkin の構文(Background、Scenario Outline、tables、docstrings、tags) | `@cucumber/gherkin`(feature を平坦な「pickle」にコンパイルする公式パーサ) |
| Step のパターンマッチング(`{string}`、`{int}`、カスタム parameter type) | `@cucumber/cucumber-expressions` |
| 見やすいレポート | Allure(nukadoko は `allure-results` を出力するのみで、HTML のレンダリングは行いません) |
| 「何が何を証明するか」の承認 | git(feature と step 定義の PR レビュー、CODEOWNERS) |
| **型付き step の契約** | **nukadoko** |
| **実行と計測(receipt)** | **nukadoko** |
| **Session、environment、secret** | **nukadoko** |
| **キーワードの意味論(Then は mutate してはならない)** | **nukadoko** |
| **Sign-off の記録** | **nukadoko** |

## 課題

ここでは、独立した 2 つの腐敗が出会います。

**BDD の腐敗。**
Cucumber では、step 定義はパターンによって自然文へと結び付けられたグルーコードです。
グルーコードのライブラリは目に見えないまま劣化し、重複した step が積み重なり、undefined な step は実行時になって初めて表面化し、step が何を受け取り何を返すかを型付けるものは何もなく、レポートは「passed」としか言えません。
実際に何が送信され何が受信されたかの記録は残りません。
キーワードは装飾に過ぎず、Cucumber は Then を Given とまったく同じように実行するため、assertion の step が状態を mutate するのを止めるものは何もありません。

**agent の腐敗。**
AI の agent がブラウザ操作を即興で行いながら受け入れ確認を実行すると、その agent は実行者であると同時に結果の報告者にもなります。
何も実行しないまま、もっともらしい結果を報告することを構造的に防ぐものは何もなく、即興で行われた操作はレビュー可能な成果物を何も残しません。

nukadoko はその両方を閉じ、操作の語彙はコミットされ型付けされレビューされます。
実行はツールが所有し、誰かの説明を信じる代わりに実際に起きたことを計測します。

## 型付き step

nukadoko は Cucumber のレイアウト規約に従い、feature ファイルとそれを支えるコードは `features/` の下に一緒に置かれるため、移行するチームは自分たちのメンタルモデルとディレクトリ構成をそのまま保てます。
型付き step の置き場所として推奨されるのは `features/steps/` で、1 step = 1 file です: `features/steps/<name>.ts`(kebab-case、ファイル名が step 名になります)。

```ts
import { defineStep } from "nukadoko";
import { z } from "zod";

export default defineStep({
  pattern: "a project {name:string} exists",  // named capture, see below
  description: "Create a project and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  mutates: true,                               // default true; see keyword semantics
  async run(ctx, args) {
    const res = await (await ctx.request()).post("/projects", { data: args });
    return res.json();
  },
});
```

- `pattern` は step を Gherkin のテキストに結び付けます。
  `patterns: [...]` はエイリアスを許可し、両方指定すると連結されて `pattern` が先に来ます。
  step は pattern を完全に省略できます。
  その場合は agent 向けの CLI 専用の語彙になり、feature ファイルからは見えませんが他の step からインポートできる、型付きの部品になります。
  `args` / `returns` のスキーマが合成の正しさをチェックし続けます。
- pattern 内のすべてのパラメータには名前が付きます。
  `{key:type}` はそのキャプチャを args のキー `key` に結び付けます。
  マッチング処理は名前を取り除き、素の `{type}` を `@cucumber/cucumber-expressions` に渡します。
  構文の所有者は変わらず、名前はその上に乗る薄い層にすぎません。
  名前は必須です(pattern 内で名前のない `{string}` は `nuka check` のエラーになります)。
  代替案(宣言順にキャプチャをスキーマのキーに結び付ける方法)では、キーの順序が入れ替わったときに同じ型の値 2 つが黙って入れ替わってしまい、静的チェックではそれを検出できないからです。
  この結び付きは、pattern 自体の中で見えることによってレビューに耐えなければなりません。
  エイリアスはすべて同じキー集合に結び付かなければなりません。
- pattern のリテラル部分も自由な散文ではなく、それ自体が cucumber-expressions の構文です。
  裸の `(` `)` は optional text、裸の `/` は alternation を意味するため、リテラルとして書きたい場合はエスケープしなければなりません。
  `pattern` の文字列リテラルの中では `\\(` `\\)` `\\/` と書きます(パースされた式の中の 1 つのバックスラッシュは、TS のソースでは 2 つになります)。
  スキーマの不一致と違い、エスケープを忘れてもビルドは成功します。
  `nuka check` は通り、step も登録されます。
  そして pattern は、それが書かれた対象の pickle のテキストに無症状のまま一切マッチしなくなります(検証で 2 つの独立した corpus がこれを踏みました)。
- optional group の中にパラメータを入れることはできません。
  これは cucumber-expressions から継承した制約です。
  末尾の場所句だけが違う複数の変種は、そのため 1 つの step + optional パラメータにまとめられず、変種ごとに別の step 定義が必要になります。
  この step 数の増加は意図した設計上のトレードオフであり、nukadoko が埋めるべき欠落ではありません。
- エイリアスは、args のレベルで真に交換可能な文(キー集合も `run()` の挙動も、どちらの言い回しにマッチしても同じ)のためのものです。
  `run()` がどちらの変種にマッチしたかを知る必要がある場合(挙動が言い回しそのもので分岐する場合)は、キー集合が偶然一致していても、変種ごとに別の step にします。
  1 つのエイリアスにまとめてしまうと、その分岐がレビュアーから見えなくなります。
- 複数形: 純粋な接尾辞の複数形(`message(s)`)には cucumber-expressions 純正の optional text `(s)` を使い、エイリアスは不要です。
  名詞自体の形が変わる場合(末尾に `s` が付くだけではない場合)は、代わりに `patterns` エイリアスを使います。
- `args` / `returns` は zod のスキーマで、実行境界でバリデーションされます(args は実行前、returns は実行後)。
  バリデーションの失敗は失敗した実行として扱われ、result は保存されません。
  キャプチャは parameter type によって型強制され(`{int}` → number、カスタム型はそれぞれの transformer による)、そのあとスキーマが契約になります。
  この対応関係は静的にチェックできます(`nuka check`)。
- step に付いた data table や docstring は、名前付きキャプチャが消費せずに残した唯一の必須 args キーに結び付きます(table は `string[][]` として、docstring は `string` として)。
  他のものと同様にスキーマでバリデーションされます。
  Gherkin の table が初めて型を持つことになります。
  attachment が存在するのに未消費の必須キーが 0 個または複数ある場合は `check`/`run` のエラーになります。
  予約されたキー名はありません。
- `mutates`(デフォルトは `true`)は、その step が触れる範囲のどこかで状態を変更するかどうかを表します。
  読み取り専用の step は `mutates: false` を宣言します。
- `run` の本体は、渡された context の上で自由に書ける TypeScript です。
  合成とは、別の step モジュールをインポートし、同じ ctx でその `run` を呼び出すことです。
  共有ヘルパーは通常のモジュール(例: `features/steps/lib/`)に置きます。
- 意味的な正しさ(実装が description と pattern の主張どおりに動くかどうか)は、ツールではなく PR レビューによって保証されます。
  `steps/` は CODEOWNERS で保護してください。

### Context API

`run(ctx, args)` に渡される `ctx`:

- `await ctx.page()`(Playwright の Page。初回呼び出しでブラウザが起動し、session の storageState から復元されます)
- `await ctx.request()`(設定された baseURL と session の cookie を持つ Playwright の APIRequestContext)
- `ctx.poll(fn, { timeout, interval, description })`(非同期ジョブに対する submit-poll-fetch)
- `ctx.section(name)`(progress log の中で実行の一区間に名前を付ける)
- `ctx.env`(設定された envFiles から得られる環境変数、読み取り専用)
- `ctx.baseURL`(設定された baseURL)
- `ctx.resultOf(stepModule)` は、現在の scenario 内でその step が直近で成功した実行の、バリデーション済みの result です。
  `nuka do` の下では、あるいはその step がまだ成功していない場合は `undefined` になります。
  これは scenario 経路のデータチャネルであり、意図的に World ではありません。
  そこには何も書き込めず、読み取れるのは `returns` のスキーマを通過した結果だけで、依存関係は他の step モジュールへの目に見える `import` になります(その step 自身のスキーマによって型付けられ、diff の中でレビューできます)。
  「その listing は閉じている」のような feature の一文は、その参照先がバリデーション済みの結果を生成した範囲でのみ実装できます。

### キーワードの意味論

Gherkin のキーワードは装飾であることをやめますが、それは宣言が信頼されるからではなく、ツールが計測するからです。
実際の corpus がこの分割を強いたのは、同じ文が Action の位置と Outcome の位置の両方に正当に現れ、慣用的なスイートが `And` を使って `Then` の後に操作を連ね、任意のコマンドをラップする step には単一の正直な `mutates` の値がないからです。
step ごとの boolean は出現ごとの事実を運べないため、強制は層になっています:

- `mutates` は step の**宣言された意図**のままです(デフォルトは `true`。読み取り専用の step は `false` を宣言します)。
- **静的には**、宣言上 mutate する step が Then の位置に結び付けられていると、`nuka check` はエラーではなく警告を出します。
  この緊張関係は人の目でのレビューに値しますが、宣言だけではそれを解決できません。
- **実行時には**、receipt がその実行が実際に行ったことを記録します。
  ツールが見たすべてのネットワーク呼び出しが対象であり(`ctx.request()` と page の両方を通じたもの)、GET/HEAD 以外の呼び出しはすべて観測された書き込みとして数えられます。
  Then の位置で実行される step は、その実行が書き込みを観測すると失敗します。
  これは宣言が何であったかにかかわらず、出現ごとに計測に基づいて判定されます。
- gherkin は `And`/`But` の step を、直前の主要なキーワード(Given/When/Then)の pickle step type を継承することで分類します。
  これは nukadoko の選択ではなく、gherkin 自身の pickle コンパイルの挙動です。
  そのため `Then` の後に連なる操作は、Then の位置の観測のもとで実行されます。
  読み取りだけをしている間は問題なく、書き込みをした瞬間に失敗します。
- 読み取り専用の environment は、宣言上 mutate する step を実行前に拒否し、さらに書き込みを観測したあらゆる実行を失敗させます。
  誤った `mutates: false` の宣言が、このポリシーをすり抜けることはできません。
- 正直な限界があります。
  観測が見るのはネットワークの書き込みだけです。
  純粋にクライアント側だけの状態や、GET で mutate するサーバーはそこからは見えません。
  それらは宣言と PR レビューが引き続き担います。
- Compat(型のない)step は静的にチェックできません。
  実行時の観測は変わらず適用されます。

## Compat step(移行の扉)

既存の Cucumber + Playwright のテストスイートにとっての導入経路は、import を 1 つ差し替えることです:

```ts
// before: import { Given, When, Then } from "@cucumber/cucumber";
import { Given, When, Then } from "nukadoko/compat";
```

- Compat の step はそのまま動きます。
  パターン構文は同じで、`page` / `request` を持つ World(`this`)は nukadoko の harness によって提供され、管理されます。
  カスタムの World クラスは `setWorldConstructor` を通じて nukadoko の基底クラスを拡張します。
  サポートされる API はよく使われるサブセット(Given/When/Then、World、Before/After)で、必要に応じて拡張され、先回りしては拡張されません。
- harness がブラウザと request のオブジェクトを所有しているため、compat の step もコードを一切変更せずに、計測済みの receipt(status、timing、trace、screenshots、HTTP log)をすでに得られます。
- compat の step に欠けているのは、型付きの契約、receipt 内でバリデーションされた `result`、単体 step の CLI 実行、そして Then の強制です。
  よく使う step を `defineStep` に昇格させることが、1 step ずつ進めるアップグレードです。

## 実行

### Scenario(スクリプト化された経路)

```sh
nuka run features/checkout.feature[:12] [--env <name>] [--session <name>] [--tag <tag>]
```

`@cucumber/gherkin` はファイルを pickle にコンパイルします(Background がマージされ、Scenario Outline が展開され、table が結び付いた、フラットで自己完結な scenario)。
nukadoko は各 pickle の step をコミットされた pattern と照合し、step を順番に実行します。
step ごとに 1 つの receipt。
pickle ごとに 1 つの scenario record(feature のパス、scenario 名、順序付けられた receipt id、step ごとの status)。

1 つの pickle 内の step は 1 つの context を共有します(Cucumber ユーザーが期待する World の意味論です)。
ログインする Background は、以降のすべての step にブラウザと cookie を引き継ぎます。
失敗した step は scenario の残りをスキップし、スキップされた step には receipt が作られません(始まってすらいない実行が引用可能であってはならず、「skipped」と言うのは scenario record の役目です)。
Evidence は自然なスコープに従います。
各 step の receipt はその step の http.jsonl を持ち、一方 Playwright の trace は共有された context にまたがるため、個々の step ではなく scenario 自身のディレクトリに置かれます。
Then の位置に対する強制は、観測によって実行時に適用されます。
Then の位置で実行され、ネットワークへの書き込みを観測した実行は失敗します(キーワードの意味論を参照)。

undefined な step は、マッチに失敗したテキストを名指しして scenario を失敗させ、`nuka scaffold` を提案します。
同梱の skill に従う agent が、欠けている型付き step を作成して PR として提出します。
feature のバックログが語彙の成長を駆動します。

### 単体 step(agent の経路)

```sh
nuka do create-project --args '{"name":"acme"}' [--env <name>] [--session <name>] [--tag <tag>]
```

1 つの型付き step を実行し、その receipt を stdout に出力します(ok なら exit 0、failed なら 1)。
これが適応的なループです。
agent はバリデーション済みの result を読み、次の呼び出しを決め、一連の呼び出しを `--tag` でグループ化します。
agent が選べるのはどの step をどの args で呼ぶかだけで、何が記録されるかを選ぶことはできません。

## Receipt

receipt とは、1 つの step の実行に対するツール自身の計測です(step が scenario の中で実行されたか `do` によって実行されたかにかかわらず、同じ形をしています)。

```json
{
  "receipt_id": "rcpt-20260801-143022-a1b2",
  "step": "create-project",
  "kind": "do",
  "args": { "name": "acme" },
  "result": { "id": "p_0001", "name": "acme" },
  "status": "ok",
  "observed": { "http_reads": 2, "http_writes": 1 },
  "environment": "dev",
  "target_version": "1.4.2+abc123",
  "session": "checkout-flow",
  "tag": "issue-123",
  "scenario": null,
  "started_at": "...",
  "finished_at": "...",
  "evidence": {
    "dir": ".nukadoko/receipts/rcpt-20260801-143022-a1b2",
    "trace": "trace.zip",
    "screenshots": ["final.png"],
    "http": "http.jsonl"
  }
}
```

- `result` は信頼の錨です。
  returns のスキーマを通過しており、それを作ったのは(呼び出し側ではなく)ツールです。
  失敗時には `error: { message }` がそれに置き換わります。
  compat の step は `result: null` を記録します。
- Evidence は harness によって収集され、step が自己申告することは決してありません。
  ブラウザが使われるときは Playwright の trace とスクリーンショット、`ctx.request()` の呼び出しはすべて http.jsonl に記録され、receipt 自体が一次記録になります。
- `observed` は、その実行に対してツール自身が見たネットワーク呼び出しを数えます(`ctx.request()` と page の両方を通じたもの)。
  GET/HEAD 以外はすべて書き込みとして数えられます。
  これは実行時のキーワード強制と読み取り専用の environment が作用する対象であり、常に計測されたものであって宣言されたものでは決してありません(キーワードの意味論を参照)。
- `used`(空でないときだけ現れます)は、この実行が `ctx.resultOf` を通じて実際に読んだ result の receipt id の一覧です。
  アクセサはツールが提供しているので、読み取りは計測可能です。
  依存関係はこうして二重に可視になります: 静的には import として、実行時には receipt 連鎖の provenance としてです。
- receipt は state directory(`.nukadoko/`、gitignore 対象)の下に置かれます。
  それらはローカルな作業記録であり、耐久性のある成果物は sign-off です。

## Session、environment、secret

Cucumber が持ったことのない実行インフラです:

- **Session** は Playwright の storageState として、CLI の呼び出しをまたいでログイン状態を運び、environment ごとに保存され、同時に 1 つの実行にだけ advisory lock されます。
  `--session` を指定しないことはクリーンな開始を意味し、暗黙に共有される状態はありません。
  daemon はありません。
- **Environment** はデプロイ先に名前を付けます。
  environment ごとの `baseURL`、`envFiles`、`policy: "read-only"`(mutate する step を拒否する)、そしてすべての receipt に `target_version` として記録される、任意の `version` プローブです。
  sign-off は、引用された receipt が 1 つの environment と version を共有していることを機械的にチェックします。
- **Secret**。
  分類するのは git です。
  git が追跡していない env file(ignore されているか untracked)は secret の源です。
  そこで定義される値はすべて secret であり、宣言は不要です。
  追跡されている env file はただの設定です(コミットされた値は secret ではなく、nukadoko もそうではないふりをしません)。
  git リポジトリの外では、すべての envFile が secret の源として扱われます。
  個々のキーは config で降格できます(`secrets: { public: [...] }`)。
  マニフェストファイルはなく、昇格もありません。
  secret の値は、receipt が出力されるあらゆる場所(receipt.json、`do` の stdout コピー、http.jsonl)で `{{secret.NAME}}` として redact されます。
  これは書き込み時に executor によって適用され、step の `run` から制御することは決してできません。
  正直な限界もあります。
  4 文字未満の値は決して redact されず、redact できるのは nukadoko 自身が読み込んだ値だけです。
  step の result の中で新たに生まれた token は捕まりません。
  Trace とスクリーンショットは redact されません。
  state directory は機密性の高いものです。
  `nuka check` は各 env file の分類と secret のキー名を報告します(値は決して報告しません)。

Configuration は `nukadoko.config.ts`(`defineConfig`)の中にあります: `featuresDir`(デフォルトは `features`。feature ファイルと step のコードは両方ともこの下に置かれる、Cucumber 流のやり方です)、`baseURL`、`envFiles`、`environments`、`stateDir`(デフォルトは `.nukadoko`)、`browser`、`secrets`。

environment のエントリは `{ baseURL?, envFiles?, policy?: "read-only", version?: () => string | Promise<string> }` です。
その `baseURL` はトップレベルのものを上書きし、その `envFiles` はトップレベルのリストのあとに追加されます(あとのファイルが勝ちます。dotenv のユーザーにはおなじみの、共通設定と上書きの重ね方です)。
`policy` と `version` は environment ごとにしか存在しません。
`--env` を指定しないことは名前 `default` を意味し、これはエントリを必要としません。
明示的に名前を付けた environment は存在していなければなりません。
名前を付けるということは、それが存在すると主張することだからです。
`version` プローブが関数になっているのは、config がすでに実行可能な TypeScript だからです(URL と jsonPath の DSL は `fetch` を書くにはより悪い方法でしょう)。
ツールはこれを実行ごとに 1 回、10 秒の予算で呼び出し、throw やタイムアウトが犠牲にするのは `target_version` だけで、実行そのものが失敗することはありません。

### State directory

nukadoko が実行時に書き込むものはすべて `.nukadoko/` の下に置かれ(`init` によって gitignore されます)、そのどれもコミットされることを意図していません:

- `receipts/<id>/`(receipt ごとに 1 つのディレクトリ: receipt の JSON、その evidence ファイル(trace.zip、screenshots、http.jsonl)、progress log)
- `scenarios/<id>/`(scenario の実行ごとに 1 つのディレクトリ: `record.json` と、scenario スコープの evidence(trace.zip、最終スクリーンショット))。
  これは Playwright 自身のテストごとの `test-results/` という規約を 1 階層上でなぞったものです。
- `sessions/<env>/<name>.json`(storageState。生の認証情報を平文で持ち、制限されたパーミッションで作成されます)
- `allure-results/`(emitter の出力、自由に再生成される)

耐久性のある成果物はその代わりにリポジトリの中に置かれます: feature ファイル、型付き step、sign-off の記録です。

## Sign-off

sign-off は「基準は満たされた」という、会話の中で蒸発してしまう主張を、記録されレビュー可能な成果物に変えます:

```sh
nuka signoff create \
  --criteria 'A project can be created and looked up by id' \
  (--receipts <id,...> | --tag <tag> | --scenario <feature:line>) \
  --reasoning 'create-project returned ok; get-project returned the same name'
```

- 作成時の機械チェック: 引用されたすべての receipt が存在し、ok であり、1 つの environment と(probe された場合は)1 つの `target_version` を共有していること。
  scenario を引用する場合はさらに scenario record もチェックされ、すべての step が順番どおりに ok で実行されたことが確認されます。
  引用された tag のもとで失敗した試みは記録として残り、目には見えても evidence として扱われることは決してありません。
- reasoning(これらの事実がなぜその基準を証明するのか)は判断です。
  nukadoko はそれを評価せず、引用する事実から恒久的に切り離した上で、人間のレビューのために保存します。
- plan のサブシステムはありません。
  「何がこれを証明するのか」という問いに答えるのは feature ファイルとそれが結び付く型付き step であり、両方とも git ネイティブなやり方(PR レビュー、CODEOWNERS、マージ)で承認されます。
  sign-off は、合意されたチェックが実際に実行されたことの記録です。
- sign-off の記録は、コミットされることを意図した小さな構造化ファイルです(デフォルトは `docs/acceptance/`)。
  検証がどう進化したかは git の履歴が運び、CI のトリップワイヤ(「docs/acceptance 配下に変更がなければプロダクトの PR を失敗させる」)が記録する習慣を生かし続けます。

## Allure emitter

nukadoko の唯一の presentation 層は `allure-results` ディレクトリです(Allure 2 のファイル形式で、Allure 2 と 3 の両方で読めます):

- scenario の実行は 1 つの Allure test result に対応します: step は step として、evidence ファイルは attachment として、environment / target_version / session は label と parameter としてです。
- `--tag` でグループ化された `do` の一連の呼び出しは、その tag の名前を持つ 1 つの test result に対応します。
  agent の session と CI のリプレイが、同じダッシュボードに着地します。
- 表示、履歴、傾向、flakiness はすべて Allure の仕事です。
  nukadoko に web UI はありません。

## Self-healing(監査付き)

スクリプト化された scenario が壊れたとき(アプリが変わり、pattern が現実にマッチしなくなったとき)、修復のループはこうなります:

1. agent が同じ tag のもとで、`nuka do` を使って目標を適応的に再実行します。
2. receipt は実際にうまくいったことを記録します。
   それはスクリプト化された scenario から逸脱した手順です。
3. スクリプトと receipt の差分は PR になります: 更新された型付き step や更新された feature ファイルであり、他の変更と同じようにレビューされます。

nukadoko の貢献は、すべての段階が記録を残すことです。
執筆は agent のワークフロー(同梱の skill)であり、エンジンの魔法ではありません。
監査証跡のない self-healing は、テストスイートが気づかないうちに何もテストしなくなる仕組みそのものです。
逸脱の記録こそが要点です。

## CLI summary

npm パッケージは `nukadoko` で、それがインストールするただ 1 つのコマンドが `nuka` です。

```
nuka run <feature[:line]>     execute scenarios; receipts + allure-results
nuka do <step> --args '<json>' execute one typed step; receipt to stdout
nuka steps [--json]           list the whole vocabulary, typed and compat:
                              name, patterns, description, mutates
nuka describe <step>          full contract, schemas as JSON Schema
nuka scaffold <name>          typed step template that fails until implemented
nuka check                    static checks: pattern/schema mismatches, Then
                              binding to mutating steps, undefined steps per
                              feature, duplicate patterns, config coherence
nuka signoff create|list|show verification records
nuka session list|clear
nuka init [--base-url <url>]  set up a project; ends with a self-check
nuka skill path|install       install the agent-facing skill
```

## Out of scope(正直な限界)

- step の実装の意味的な真偽は PR レビューに委ねられます。
  ツールが保証するのは入出力の形と、実行された事実だけです。
- nukadoko は、shell アクセスを持つ agent が `.env` を直接読むことを止められません。
  nukadoko がなくすのは、secret が agent の context を通過する構造的な必要性です。
- sign-off は証明ではありません。
  それは判断についての、耐久性がありレビュー可能な記録です。
- テストの並列実行、sharding、retry、CI レポーティングはありません。
  nukadoko 自身による outbound のネットワーク I/O もありません。
  HTML のレンダリングもありません。
  それは Allure の仕事です。

## ロードマップ

- **M1(engine core)**: `defineStep`、`do`、pickle に対する `run`、receipt、session/environment、`check`、`init`。
  secret のオンボーディングは再設計されました。
- **M2(compat API)**: `nukadoko/compat`(Given/When/Then/World/hooks のサブセット)、cucumber-js + Playwright のスイート向け移行ガイド。
- **M3(Allure emitter)**: scenario の実行と tag の一連の呼び出しのための allure-results。
  drop-in なダッシュボードのストーリー。
- **M4(sign-off)**: 記録、機械チェック、CI トリップワイヤのレシピ。
- **Later**: AI 支援の glue コンバータ(既存の正規表現ベースの glue → 型付き step)、scenario の harvesting(裏付けられた `do` の一連の呼び出しから feature ファイルを生成する)、tag-expression によるフィルタリング、移行ではなくその場での共存が必要な実際のスイートのための cucumber-js アダプタ。

## 実装ノート

- 予定されているランタイム依存: `@cucumber/gherkin`、`@cucumber/cucumber-expressions`、`playwright`、`zod`、`tsx`(実行時の TS インポート)、CLI フレームワークは TBD。
  Node は 20 以上。
- id の形式: `<kind>-<timestamp>-<short random>`。
- `nuka steps` と `nuka describe` は step モジュールをインポートします(compat の登録と pattern を集めるにはそれが必要だからです)。
  インポートはファイルのトップレベルのコードを実行するため、実行時と同じ注意が必要です。
  Shell の補完は決してインポートしません。
  型付き step の名前はファイル名から、id と session の名前は state directory から補完されるため、語彙の量にかかわらず TAB は高速なままです。
- 最初の実世界での検証ゲート(M2 が詳細に設計される前)。
  約 10 個の実際の feature ファイルを結び付け、AI が下書きした型付き step をレビューすることが、手で glue を書くことより実際に優れているかを測ります。
