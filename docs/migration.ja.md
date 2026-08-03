# cucumber-js + Playwright スイートの移行

> 原文は migration.md。相違があれば原文が正。

既存の cucumber-js スイートを Playwright に対して実行しているチーム向けで、feature ファイルと step の定義は `features/` 配下にあります(cucumber-js 自身のレイアウト規約であり、nukadoko のデフォルトでもあります)。
書き換えは不要です: 目標は、スイートを変更せずに nukadoko の harness 上で実行し、その後は自分のペースで一部ずつ昇格させることです。
以下の各段階の実際に取得したコマンド出力を伴う完全な実例については、[examples/migration](https://github.com/meganemura/nukadoko/tree/main/examples/migration) を参照してください。

## Stage 0: nukadoko をインストールしてスイートに向ける

nukadoko をインストールし、プロジェクトルートから `nuka init` を実行します(あるいは `nukadoko.config.ts` を手書きします):

```ts
import { defineConfig } from "nukadoko";

export default defineConfig({
  baseURL: "http://localhost:...", // wherever the app under test listens
  featuresDir: "features",         // point this at your existing features/
});
```

`nuka init` は `nukadoko.config.ts` が既に存在する場合は実行を拒否し、`<featuresDir>/steps/` を作成し、`.nukadoko/` を `.gitignore` に追加し、(まだ空の)語彙を発見する self-check で終わります。
`featuresDir` はデフォルトで `features`(cucumber-js 自身の規約)なので、ほとんどのスイートは上書き不要であり、discovery はディレクトリ全体をたどるため、その配下の別の場所にある step ファイル(`features/step_definitions/`、`features/support/`)も並べ替えは不要です。

## Stage 1: import を差し替える

step ファイルが使っている import を 1 つ差し替えます:

```ts
// before: import { Given, When, Then } from "@cucumber/cucumber";
import { Given, When, Then } from "nukadoko/compat";
```

その import より下は、変更せずにそのまま動き続けます:

- string と RegExp の pattern は、cucumber-js が一致させるのとまったく同じように一致します(named capture は要求されません。その規律は typed step のものです)。
- `Given(pattern, fn)` と `Given(pattern, { timeout }, fn)` のどちらの登録形も受け付け、その `timeout` は尊重されます。
- `World`(`this`)、cucumber-js が受け付ける 3 つの書き方(`Before(fn)`、`Before({ tags }, fn)`、裸の文字列の `Before("@tag", fn)`)で書ける、単一の `@tag` または `not @tag` でフィルタされる `Before`/`After` フック、カスタムの `setWorldConstructor` サブクラス。
  フックは cucumber 自身のフック引数を受け取るので、`Before(function ({ pickle }) {...})` は書いたとおりに動きます。
- `DataTable`(`raw()`/`rows()`/`hashes()`/`rowsHash()`/`transpose()`)。
  `table.hashes()` を呼ぶ step は書いたとおりにそのまま動き続けます(摩擦ゼロで、examples/migration 自身のスイートを移行する形で計測済みです)。
- glue 内の `allure.*` 呼び出し(`attach`/`log`/`link`、ラベル、パラメータ)は、消えるのではなく receipt の `declared` フィールドに入ります。
- `setDefaultTimeout(ms)` は、自分の timeout を宣言していない step や hook すべてにその既定値を埋め、cucumber-js と同じく最後に呼んだものが勝ちます。
  一度も呼ばなければ、step は cucumber の 5 秒という既定値を採用する代わりに無制限のままになります。
  スイートが移行しただけで、遅い step のせいで失敗し始めるべきではないからです。
- `BeforeAll` / `AfterAll` は、run 全体を挟み込み、`{ timeout }` を渡せばそれも効きます。
  実行されるのは scenario が 1 つ以上選ばれたときだけで、`tags` は取らず、World(`this`)も渡されません(`BeforeAll` が走る時点ではまだ何も存在しないからです)。
  `BeforeAll` は最初の失敗で止まり、それ以降どの scenario も実行されません。
  `AfterAll` はそれでも試みられ、兄弟のどれかが例外を投げていても登録はすべて実行され、teardown は登録順とは逆順にほどけます。

### 切り替えで引き継がれないもの

公開されている cucumber-js のスイート 8 本を、この扉に対して監査しました。
glue はテキストとして読むだけで、実行はしていません。
**その監査を行った時点では、import の差し替えだけで通ったものは 1 つもありませんでした。**
そこで見つかった最も頻出の障害に対応したことで、8 本のうち 2 本はその後、glue の中に拒まれるものが何もない状態になりました。
残る 6 本は、まだ短い準備を先に必要とします。
(これは静的な主張として読んでください。実際その通りで、それらの glue にはもう、この扉が拒むものは何も残っていません。
それらのスイートを実行したわけではありません。)
以下はどれも、import の時点か最初の `nuka run` で、大きな声で失敗します。
だからこの準備は、探し物ではなく順にこなせるリストです。

- **`nukadoko/compat` がエクスポートしていない名前**: `AfterStep`、`Status`、`setParallelCanAssign`、および `IWorldOptions` / `ITestCaseHookParameter` の型です。
  ES モジュールの named import はリンク時に解決されるため、サポートされていない名前が 1 つあるだけで、import 文全体(ひいてはそのファイル)が丸ごと落ちます。
  import を分割するか、その呼び出しを削ってください。
  (`BeforeAll`、`AfterAll`、`setDefaultTimeout` は監査を行った時点ではこのリストに含まれていましたが、今ではサポートされています。以下を参照してください。)
- **CommonJS の glue**: nukadoko は ESM 専用なので、`require("nukadoko/compat")` は `ERR_PACKAGE_PATH_NOT_EXPORTED` で即座に失敗します。
  8 本のうち 2 本は、全体が CommonJS のスイートでした。
  この扉が受け入れるのは ES module の glue だけです。
- **深い subpath の import**(`import DataTable from "@cucumber/cucumber/lib/models/data_table"` など)には、ここでは対応するものがありません。
  代わりに `nukadoko/compat` から `DataTable` を import してください。
- **単一の `@tag` / `not @tag` を超える hook のタグ式**(`and`、`or`、括弧)は、`nuka run` した瞬間に失敗します。
- step や hook から **`"pending"` または `"skipped"` を返すこと**、および **done コールバックの glue**(`function (arg, done) {...}`)は、それぞれ代わりに何を書くべきかを示すメッセージ付きで失敗します。
  cucumber-js はこの両方に意味を持たせていますが、nukadoko は持たせておらず、step を通過させる代わりにそう伝えます。

`nuka run features/your.feature` でスイートを実行します。
あらゆる step が receipt を得るようになり、それ以外に何かを変える必要はありません。

## 計測されるアップグレード(任意)

自前で Playwright のブラウザや request クライアントを起動する glue は、計測されないまま動き続けます(nukadoko は一切手を触れません)。
その bootstrapping を `await this.openPage()` / `await this.openRequest()` に置き換えると(混在 scenario の typed step と同じ context に委譲し、scenario ごとに 1 つのブラウザと 1 つのセッションです)、その step の receipt は他のコード変更なしに trace、`http.jsonl` log、`observed` の読み書き件数を得ます。

## Stage 1.5: 依存しているものを宣言する

互いに独立した、順不同で単独でも安全に行える 2 つの漸進的な一手があります:

- **World keys**: 依存しているキーを `defineWorld({ key: someZodSchema })` でラップして拡張します(`class MyWorld extends defineWorld({ seededCount: z.number() })`)。
  そのキーへの書き込みはこれで検証されるようになり(スキーマに失敗した書き込みは step を失敗させ、記録されません)、それ以外のすべてのキーは計測されるが検証されないまま動き続けます。
  `MyWorld` の `this` も、宣言されたキーについては型が付きます。
- **Parameter types**: support 側の `defineParameterType` 呼び出しは引き続き動きますが、`nuka check` が警告し(`parameter-type-support-origin`)、typed 時代の住まいとして `config.parameterTypes` を指し示します(登録を移してもどの pattern のマッチも変わりません)。

## Stage 2: step を昇格させる

consumer より先に producer を昇格させます: `this` にデータを溜め込んでいた step を `defineStep` にし、読み手は `this` を読む代わりに `ctx.resultOf(producerModule)` を通じてその結果を取得するようにします。
昇格した step は、型付きの契約、検証済みの `result`、`nuka do` による単体実行を得ます(そのどれも compat の step にはありません)。

## ダッシュボードは `nuka check`

`nuka check` は、移行がどれだけ残っているかを示す走行メーターです:

- `then-compat-step` は、compat の step が `Then` の位置に結び付けられていると警告します。
  compat の step には、そこで nukadoko が信頼できる宣言済みの `mutates` がありません(docs/spec.ja.md の「キーワードの意味論」を参照)。
  そのためこの警告が示しているのは、その位置に静的な手掛かりが何もないという事実であり、ツールが何かを捕まえたわけではありません。
  `defineStep` に昇格させることが、チェックできる宣言を得る方法です。
- `parameter-type-support-origin` は、support 側の `defineParameterType` すべてに対して警告し、上記の config への移動を指し示します。
- receipt は実行時に同じ話を語ります: スイートがより多く typed step と `ctx.resultOf` に昇格するにつれて、`world`(compat の step のみ)と `declared` が縮んでいきます。

## 戻り道

これらはどれも一方通行ではありません。
import を `@cucumber/cucumber` に戻せば(`openPage()`/`openRequest()` が置き換えた Playwright の bootstrapping も元に戻せば)、スイートは再びただの cucumber-js スイートになります。

## 既知の限界

- hook 自身のネットワーク通信はどの step の境界にも属しません(どの step の `observed` にもカウントされません)。
- World の計測が見るのは World 自身の own データプロパティだけです。
  `#private` のフィールドは、構造上 `world.reads`/`world.writes` に現れません。
- 宣言された attachment のファイル内容は redact されません(trace や screenshot がすでに抱えているのと同じ正直な限界です)。
- `BeforeAll`/`AfterAll` の失敗は、stderr と exit code だけに報告されます。
  record は scenario ごとに書かれますが、これらの hook はどの scenario にも属しません。
  そのため、run レベルの hook 用の行き先はまだありません。
