# cucumber-js + Playwright スイートの移行

> 原文は migration.md。
> 相違があれば原文が正。

既存の cucumber-js スイートを Playwright に対して実行しているチーム向けで、feature ファイルと step の定義は `features/` 配下にあります(cucumber-js 自身のレイアウト規約であり、nukadoko のデフォルトでもあります)。
書き換えは不要です: 目標は、スイートを変更せずに nukadoko の harness 上で実行し、その後は自分のペースで一部ずつ昇格させることです。
既存のスイートは CommonJS のこともあります(自分の `package.json` に `"type": "module"` が無い場合)。
この扉はそこでも動きます。
nukadoko の設定と step ファイルの両方で、`.ts` の代わりに `.mts` を使います(下の Stage 0)。
以下の各段階の実際に取得したコマンド出力を伴う完全な実例については、[examples/migration](https://github.com/meganemura/nukadoko/tree/main/examples/migration) を参照してください。

そもそも cucumber-js のスイートがなければ、以下はどれも当てはまりません。
Playwright Test に対して直接書かれたプロジェクトで、feature ファイルも切り替える glue もない場合は、別の扉から始まります。
[docs/migration-playwright-test.ja.md](migration-playwright-test.ja.md) を参照してください。
独自の DSL で、すでに型付き step の形をしたスイートは、[型付き step の DSL から来る場合](#型付き-step-の-dsl-から来る場合)から始まります。
どこから始めても、[進め方の決まり](#進め方の決まり)はすべての道で成り立ちます。
移行を行うエージェントは、最初の変更の前にそれを読みます。

## Stage 0: nukadoko をインストールしてスイートに向ける

nukadoko をインストールし、プロジェクトルートから `nuka init` を実行します(あるいは `nukadoko.config.ts` を手書きします):

```ts
import { defineConfig } from "nukadoko";

export default defineConfig({
  baseURL: "http://localhost:...", // wherever the app under test listens
  featuresDir: "features",         // point this at your existing features/
});
```

CommonJS のスイートでは、`nuka init` は代わりに `nukadoko.config.mts` を書きます(中身は同じで、stderr にその旨を伝えます)。
そこでは step ファイルも同じ `.mts` 拡張子にする必要があります。
`"type": "commonjs"` では、Node はふつうの `.ts` ファイルを CommonJS として読み、nukadoko は ESM 専用だからです。
そのため `nukadoko.config.ts` を手で書くと、読み込みに失敗します。
エラーはそのファイルと原因を名指しし、ファイルが `.ts` なので `.mts` へのリネームを案内します。
`"type"` が無い場合、Node は `.ts` ファイルを解析し直してから読み込み、読み込むたびに `MODULE_TYPELESS_PACKAGE_JSON` の警告を出します。

`nuka init` は `nukadoko.config.ts` か `nukadoko.config.mts` のどちらかが既に存在する場合は実行を拒否し、`<featuresDir>/steps/` を作成し、`.nukadoko/`、`.env`、`.env.*` を `.gitignore` に追加し(`!.env.example` で example は追跡されたままにします)、(まだ空の)語彙を発見する self-check で終わります。
`featuresDir` はデフォルトで `features`(cucumber-js 自身の規約)なので、ほとんどのスイートは上書き不要であり、discovery はディレクトリ全体をたどるため、その配下の別の場所にある step ファイル(`features/step_definitions/`、`features/support/`)も並べ替えは不要です。

`this.parameters` を読む cucumber-js スイートは、そのオブジェクトを cucumber.js プロファイルの `worldParameters` か、コマンドラインの `--world-parameters` から受け取っていました。
同じオブジェクトを `nukadoko.config.ts` の `worldParameters` に置いてください。
World のコンストラクタはそれを `parameters` として受け取ります。
デフォルトは `{}` です。
それを渡すコマンドラインのフラグはありません。
オブジェクトを設定する場所はこのキーだけです。

```ts
export default defineConfig({
  worldParameters: { baseUrl: "http://localhost:..." },
});
```

## Stage 1: import を差し替える

step ファイルが使っている import を 1 つ差し替えます:

```ts
// before: import { Given, When, Then } from "@cucumber/cucumber";
import { Given, When, Then } from "nukadoko/compat";
```

その import より下は、下の「既知の限界」に挙げた違いを除いて、変更せずにそのまま動き続けます:

- string と RegExp の pattern は、cucumber-js が一致させるのとまったく同じように一致します(named capture は要求されません。
  その規律は typed step のものです)。
- `Given(pattern, fn)` と `Given(pattern, { timeout }, fn)` のどちらの登録形も受け付け、その `timeout` は尊重されます。
- `World`(`this`)、cucumber-js が受け付ける 3 つの書き方(`Before(fn)`、`Before({ tags }, fn)`、裸の文字列の `Before("@tag", fn)`)で書ける、単一の `@tag` または `not @tag` でフィルタされる `Before`/`After` フック、カスタムの `setWorldConstructor` サブクラス。
  フックは cucumber 自身のフック引数を受け取るので、`Before(function ({ pickle }) {...})` は書いたとおりに動きます。
  `After` は `result.duration` を受け取り、scenario が失敗したときは `result.message` と `error` も受け取ります。
  `AfterStep` もそれらを受け取り、加えて直前の step の `pickleStep` と `testStepId` を受け取ります。
- `this.attach` は cucumber-js の形を受けます。
  文字列(`base64:<media type>` を含む。
  ファイルには復号したバイトが書かれます)、buffer、`{ mediaType, fileName }`、readable stream です。
  stream は promise を返すので、step はそれを await します。
  `this.link` は URL を 1 つ以上受け取り、それぞれが `declared` の link 1 件になります。
  第 2 引数は名前ではなく、もう 1 つの URL です。
- カスタム World のコンストラクタが throw した場合、その scenario は失敗します。
  stderr には setup の 1 行が出て、scenario record は failed になり、step record は引用されません。
  同じ run の後続 scenario は実行され、messages の export は完了します。
- `Before`、`After`、`BeforeAll`、`AfterAll` の `{ name }` は、フックのタイトルとして保存され、表示に使われます。
  どの scenario で走るか、timeout、登録順は変わりません。
  `AfterStep` は `name` を受け付けません。
  `BeforeAll` と `AfterAll` は `on` を拒み続けます。
  `on` はフックを動かすプロセスを選ぶオプションだからです。
- `AfterStep` は `Before`/`After` と同じ 3 通りの書き方で登録します。
  scenario 全体につき 1 回の `Before`/`After` と違い、scenario 内で実際に実行された step ごとに 1 回走ります。
  この scenario がそれより前の step の失敗によってスキップした step は始まってすらいないため、`AfterStep` もその step については走りません。
  始まってすらいない step に「後」は存在しないからです。
- `Status` は cucumber-js 自身の `TestStepResultStatus` enum を同じ名前で re-export したものです。
  `Before` / `After` / `AfterStep` フック内の `result.status === Status.FAILED` は、これで正しく import され比較できるようになります。
- `DataTable`(`raw()`/`rows()`/`hashes()`/`rowsHash()`/`transpose()`)。
  `table.hashes()` を呼ぶ step は書いたとおりにそのまま動き続けます(摩擦ゼロで、examples/migration 自身のスイートを移行する形で計測済みです)。
- glue 内の `allure.*` 呼び出し(`attach`/`log`/`link`、ラベル、パラメータ)は、消えるのではなく step record の `declared` フィールドに入ります。
- `setDefaultTimeout(ms)` は、自分の timeout を宣言していない step や hook すべてにその既定値を埋め、cucumber-js と同じく最後に呼んだものが勝ちます。
  負の値は無制限を意味します。
  `setDefaultTimeout(-1)` と、step や hook の `{ timeout: -1 }` がそれです。
  0 は制限時間として効きます。
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
(これは静的な主張として読んでください。
実際その通りで、それらの glue にはもう、この扉が拒むものは何も残っていません。
それらのスイートを実行したわけではありません。)
以下はどれも大きな声で失敗しますが、そのタイミングは一様ではありません。
その一部は何かを実行するより前に `nuka check` がすでに名指しし、その一部はその step に達した最初の `nuka run` で初めて表に出ます。
どちらなのかは以下の各項が言うので、この準備は探し物ではなく順にこなせるリストです。
失敗せずに値だけを変える違いは、このリストにはありません。
計測済みのものは下の「既知の限界」に挙げています。

- **`setParallelCanAssign` を値として使う**: `nukadoko/compat` はこれを export していません。
  ES モジュールの named import はリンク時に解決されるため、これを import して呼び出すだけで import 文全体、ひいてはそのファイルが丸ごと落ちます。
  import を分割するか、その呼び出しを削ってください。
  何かが実行されるより前に捕まります: `nuka check` は、そのファイルを Node 自身のエラーメッセージ付きの `step-file-import-failed` として報告し、`check` を省略していた場合は同じ失敗がそのファイルを import しようとする最初の `nuka run` で表に出ます。
  この名前は、`setParallelCanAssign` が worker に渡せる pickle を決めるため、設計上の判断によって未対応のままです。
  nukadoko は feature ファイル全体を配るため、worker への割り当てには、このコールバックが制御する pickle 単位の判断がありません。
  feature ファイル単位の相互排他は、feature に付けた `@nukadoko:serial` タグで宣言します。
  この呼び出しを no-op として受け入れることは、拒否するより悪い結果になります。
  それは import が通って実行され、並列割り当てのルールが効いていると信じたままのスイートに、何も強制しないまま残すことになるからです。
  これはまさに、この扉が拒むために存在する静かな失敗そのものです(docs/spec.ja.md「Compat steps(移行の扉)」)。
  import の時点で失敗させることが、その約束を守ります。
  このリストの他のすべての名前と同じやり方です。
  feature ファイル全体を worker プロセスへ渡しているのは `nuka run --concurrency <n>` です。
  (`AfterStep`、`Status`、`BeforeAll`、`AfterAll`、`setDefaultTimeout` は監査を行った時点ではこのリストに含まれていましたが、今ではサポートされています。
  上記を参照してください。)
- **同じ種類の名前でも、型としてしか使っていない場合**は別のケースであり、上のケースを小さくしたものではありません。
  結果は import の書き方で決まります。
  Node は glue を型の除去で読み込み、`import type`(またはインラインの `type` の名前)を消し、それ以外の import はすべて残します。
  `type` を付けて書けば、その名前は実行時には import されません。
  `nuka check` も `nuka run` も何も問題を見つけず、文句を言うのは `tsc` だけで、それは `tsc` の仕事です。
  `type` なしで書くと import が残り、そのファイルは Node の "does not provide an export named" エラーで失敗し、`nuka check` はそれを `step-file-import-failed` として報告します。
  `nukadoko/compat` が export する型なら、finding はそのことを伝えます。
  そのような import には `type` を付けてください。
  `"verbatimModuleSyntax": true` にすると、`tsc` がすべての該当箇所を見つけます。
  cucumber-js の glue は `IWorldOptions` を `World` と並べて `type` なしで import していることが多いので、最初の実行の前に検索しておく価値があります。
  (このカテゴリの監査自身の例だった `IWorldOptions` と `ITestCaseHookParameter` は、今では export されています。
  `WorldConstructorParams`/`HookParameter` のエイリアスとして、他の compat の名前と同じように typecheck を通ります。)
- **CommonJS の glue**: nukadoko は ESM 専用です。
  discovery がファイルをどう扱うかは拡張子で決まります: `.ts`、`.mts`、`.js`、`.mjs` はいずれも歩かれて import されます(`.ts` だけでなく素の `.js` だけで書かれたスイートも、以前のように discovery から見えなくなることはもうありません)。
  `.cjs` と `.cts` のファイルは名指しできる程度には歩きますが、まったく import されないため、失敗すべき import そのものが存在しません。
  `nuka check` は代わりにそれを `step-file-unsupported-extension` として報告します。
  discovery が実際に import するファイルの中では、`require("nukadoko/compat")` は今までどおり `ERR_PACKAGE_PATH_NOT_EXPORTED` で即座に失敗します。
  拡張子だけでは、そのファイル自身のコードが ES module の glue になるわけではないからです。
  8 本のうち 2 本は、全体が CommonJS のスイートでした。
  この扉が受け入れるのは ES module の glue だけです。
  どちらの経路でも、何かが実行されるより前に捕まります: `.cjs` または `.cts` のファイルなら `step-file-unsupported-extension`、discovery が実際に開いたファイルの中の `require()` 呼び出しなら `nuka check` の `step-file-import-failed`(または `check` を省略していた場合は最初の `nuka run`)です。
- **深い subpath の import**(`import DataTable from "@cucumber/cucumber/lib/models/data_table"` など)には、ここでは対応するものがありません。
  代わりに `nukadoko/compat` から `DataTable` を import してください。
  同じ経路で捕まります: `nuka check` の `step-file-import-failed`、または `check` を省略していた場合は最初の `nuka run` です。
- **単一の `@tag` / `not @tag` を超える hook のタグ式**(`and`、`or`、括弧)。
  `nuka check` は違反しているすべての hook を前もって報告し(`unsupported-hook-tag-expression`)、`nuka run` も同じ規則を強制しますが、run は一覧ではなく終了するものなので、最初に当たった 1 つで止まります。
- step や hook から **`"pending"` または `"skipped"` を返すこと**は、代わりに何を書くべきかを示すメッセージ付きで失敗します。
  これは `nuka check` からは見えません。
  関数が実際に実行されたときに返す値の性質であり、ファイルの import のされ方の性質ではないため、その実行より前には不備を名指しできません。
  その step に達した最初の `nuka run` で表に出ます。
- **done コールバックの glue**(`function (arg, done) {...}`)も、同じ種類のメッセージ付きで失敗します。
  `nuka check` はそれを先に `done-callback-arity` として報告します。
  hook が上限を超えるのは、Before、After、AfterStep が引数を 2 つ以上宣言したときと、BeforeAll、AfterAll が引数を 1 つ以上宣言したときです。
  マッチした compat step が上限を超えるのは、関数の引数の数が、その行の capture に table または docstring を足した数を超えるときです。
  マッチしていない step については黙ります。
  capture の数は、その step を選んだ行から決まるからです。
  cucumber-js は戻り値の文字列とコールバックの両方に意味を持たせていますが、nukadoko は持たせておらず、step を通過させる代わりにそう伝えます。

`nuka run features/your.feature` でスイートを実行します。
あらゆる step が step record を得るようになり、それ以外に何かを変える必要はありません。

## 計測されるアップグレード(任意)

自前で Playwright のブラウザや request クライアントを起動する glue は、計測されないまま動き続けます(nukadoko は一切手を触れません)。
World のサブクラスは、その page と request を `this.page = ...` と `this.request = ...` で代入し、後から読むと、`openPage()` や `openRequest()` が保存した値より先にその代入した値が返ります。
その bootstrapping を `await this.openPage()` / `await this.openRequest()` に置き換えると(混在 scenario の typed step と同じ context に委譲し、scenario ごとに 1 つのブラウザと 1 つのセッションです)、その step の step record は他のコード変更なしに trace、`http.jsonl` log、`observed` の読み書き件数を得ます。

## Stage 1.5: 依存しているものを宣言する

互いに独立した、順不同で単独でも安全に行える 2 つの漸進的な一手があります:

- **World keys**: 依存しているキーを `defineWorld({ key: someZodSchema })` でラップして拡張します(`class MyWorld extends defineWorld({ seededCount: z.number() })`)。
  そのキーへの書き込みはこれでバリデーションされるようになり(スキーマに失敗した書き込みは step を失敗させ、記録されません)、それ以外のすべてのキーは計測されるがバリデーションされないまま動き続けます。
  `MyWorld` の `this` も、宣言されたキーについては型が付きます。
  `page` と `request` は宣言しません。
  それらは harness の getter です。
  サブクラスは、これまでどおりそれらを代入できます。
  harness のオブジェクトには `await this.openPage()` と `await this.openRequest()` で到達します。
  `defineWorld` は import 時にどちらの名前も拒みます。
  `nuka check` は `step-file-import-failed` を報告し、`nuka run` は同じメッセージで止まります。
  そのメッセージはフィールド名を含みます。
- **Parameter types**: support 側の `defineParameterType` 呼び出しは引き続き動き、typed 時代の住まいは `config.parameterTypes` です(`preferForRegexpMatch` を設定していなければ、登録を移してもどの pattern のマッチも変わりません)。
  transformer の `this` はその scenario の World であり、返した Promise は step が走る前に await されます。
  string の pattern でも RegExp の pattern でも同じです。
  `preferForRegexpMatch` は、cucumber-js と同じく、複数の型が一致する RegExp のグループに使う型を選びます。
  `config.parameterTypes` にはこのキーがないため、これを設定する登録は、RegExp の step がそれに頼っている間は support コードに残ります。
  キーごと config へ移すと config のエラーになります。
  キーを外して移すと、2 つの型が一致する RegExp のグループは、再び "matches multiple parameter types" で step を失敗させます。

## Stage 2: step を昇格させる

consumer より先に producer を昇格させます: `this` にデータを溜め込んでいた step を、`returns` スキーマを持つ `defineStep` にします。
読み手は、`this` から読んでいたキーについて `from: { key: [producerStep, "resultKey"] }` を宣言します(参照: docs/spec.ja.md の「step の連鎖」)。
これが、既存の `this` への書き込みのほとんどが実は表していたものをカバーします: 1 つの名前付きキーで読める 1 つの名前付きの値です。
読み方がそれに当てはまらない場合(値の変形が要る、どの producer から読むかが実行時にしか決まらない、あるいは 1 つのキーではなく result 全体が欲しい場合)は、引数を optional のままにし、`run` 自身の fixture の 1 つである `resultOf` に、`resultOf(producerModule)` としてフォールバックします。
これは `this` がかつて答えていたのと同じ読みであり、違いはいまやバリデーション済みの result に対して行われる点だけです。
昇格した step は、型付きの契約、バリデーション済みの `result`、`nuka do` による単体実行を得ます(そのどれも compat の step にはありません)。

## ダッシュボードは `nuka check`

`nuka check` は、移行がどれだけ残っているかを示す走行メーターです:

- `then-compat-step` は、compat の step が `Then` の位置に結び付けられていると警告します。
  compat の step には、そこで nukadoko が信頼できる宣言済みの `mutates` がありません(docs/spec.ja.md の「キーワードの意味論」を参照)。
  そのためこの警告が示しているのは、その位置に静的な手掛かりが何もないという事実であり、ツールが何かを捕まえたわけではありません。
  `defineStep` に昇格させることが、チェックできる宣言を得る方法です。
- `step-file-import-failed` は、import が例外を投げた step ファイルにエラーを出します。
  未サポートの名前を値として使っている、CommonJS の `require`、深い subpath の import(上の「切り替えで引き継がれないもの」の最初の 3 つの gap です)のいずれかで、Node 自身のエラーメッセージとファイルパスを運びます。
  プロジェクトの残りはそれと並行して引き続き discovery され報告されます。
  移行中のスイートの通常の状態は一部の glue がまだ壊れていることであり、ダッシュボードを空白にする理由にはなりません。
- `step-file-unsupported-extension` は、discovery が `featuresDir` の下で歩いたものの一度も import しなかった `.cjs` または `.cts` のファイルにエラーを出します。
  上の gap 群と違い、この所見の背後には失敗すべき import の試みそのものがないため、`step-file-import-failed` を使い回さずに独自のコードを持ちます。
  どちらの所見も、ファイルパスを名指しします。
- `no-step-files-found` は、`featuresDir` の下を歩いた結果として読み込めるものが 1 つも見つからなかったときにエラーを出し、実際にスキャンしたディレクトリを名指しします。
  これは、まるごと未サポートな形のスイート(glue がすべて `.cjs` である、あるいは `featuresDir` が glue の無い場所を指している)と、単にまだ報告することが何もないだけのスイートとを見分ける方法です。
- `unsupported-hook-tag-expression` は、単一の `@tag` / `not @tag` を超えるタグ式を持つすべての hook にエラーを出し、`nuka run` が止まる最初の 1 つだけではありません。
- `done-callback-arity` は、compat の hook が nukadoko の渡す数より多くの引数を宣言したとき、またはマッチした compat step の関数がその行の capture に table または docstring を足した数より多くの引数を宣言したときにエラーを出します。
  `"pending"` または `"skipped"` を返すことは、今までどおり実行時の失敗です。
  戻り値は関数が走るまで分からないからです。
- `undefined-step-check-suppressed` は、上の import の失敗が本来引き起こすはずの `undefined-step` エラーを抑え込んでいるときに警告します。
  1 つの壊れたファイル自身の step が語彙から消えることは、それ以外の方法だと無関係な undefined step の山にしか見えません。
  まず import の失敗を直してください。
  抑え込まれていた findings は、そのファイルが問題なく import できるようになった時点で、本物の `undefined-step` エラーとして再び現れます。
- step record は実行時に同じ話を語ります: スイートがより多く typed step に昇格し、その読み手が `from` 経由でそれを読むようになるにつれて(キー名で表せない読みは `resultOf`)、`world`(compat の step のみ)と `declared` が縮んでいきます。

## 戻り道

import の切り替えは可逆であり、それは偶然の産物ではなく変わらない設計上の規則です。
`@cucumber/cucumber` に戻せば(`openPage()`/`openRequest()` が置き換えた Playwright の bootstrapping も元に戻せば)、compat の上にまだ乗っているものはすべて、再びただの cucumber-js スイートになります。

`defineStep` に昇格させた step は話が別であり、ここまでの内容はそれをカバーしているとは読まないでください。
`defineStep` は nukadoko 自身の API です: 切り替えて戻す import がありません。
それが実際に何を犠牲にするのかは具体的に述べる価値があります。
「ロックインされる」という言葉が示唆するより、範囲は狭いからです。

昇格させた step が出口で手放すのは、そのスキーマの上に組まれたものすべてです: `args`/`returns` のバリデーション、step record の `result`、`from` とそれを読む束縛順序のチェック、そして `nuka check` が行う契約チェックです。

手元に残るのは body です。
`run` は Playwright 自身の `Page` と `APIRequestContext` に対して書かれており、nukadoko は意図的にそれらをラップしません(docs/spec.ja.md の「Out of scope(正直な限界)」を参照)。
実際に作業を行うコードは、分割代入で受け取っていた `page`/`request` を World が渡すものに置き換えるだけで、そのまま cucumber-js の step へと移ります。
残りは機械的な作業です: pattern から named capture を落とし(`{name:string}` → `{string}`)、`returns` が返していたものをもう一度 `this` に書き、`from` が宣言していたものをもう一度 `this` から読みます。

nukadoko はその変換のためのツールを同梱しておらず、これは昇格に反対する論拠としてではなく、限界として述べています。
import の可逆性が存在するのは最初の一歩を編集 1 つ分のコストにするためであって、型付き側を選択制にするためではありません: compat はスイートが到着する場所であり、このツールをそもそも走らせる理由のすべて(バリデーション済みの `result`、`nuka check` が feature を突き合わせられる契約、`from`、「実行された」以上のことを証言する run サマリ)は、昇格の向こう側にあります。
契約を持たせたい step を昇格させてください。
時間が経てば、それが重要な step の大半になっているはずです。

## 型付き step の DSL から来る場合

feature ファイルも cucumber の glue も無いなら、上の compat の扉は当てはまりません。
`defineStep` の `pattern` は省略できます。
pattern の無い step も完全な語彙であり、`nuka do` で実行でき、`nuka describe` で読めます。
そのため、同じ規則から別の 2 段階が出てきます。
まず各 step を型付きの `defineStep` に移し、feature ファイルで使う価値が出たときに Gherkin の `pattern` を与えます。

移行元の DSL が description、args、returns、書き込みのフラグ、run 関数をすでに持っているなら、そのまま移せます。
`defineStep` にはそれぞれを受け取るフィールドがあります。
移したスキーマを JSON Schema で表せなくても、`nuka describe` は止まりません。
その step の契約を出力し、step の名前を挙げ、1 で終了します。

## 進め方の決まり

どの扉からスイートが入っても、これらは成り立ちます。

- **2 段階を、決して同時にしない。**
  1 つ変えてから、次を変えます。
  2 つの変更が一緒に入ったあとで step が壊れると、どちらが壊したのかを知る手がかりがありません。
  ここではその 2 段階は「import を差し替える」と「型を付ける」です。
  ほかの扉は、同じ規則から自分の 2 段階を導きます。
- **最初の変更の前に、今どこにいるかを言う。**
  段階の名前、それが触るもの、触らないものを言います。
  import の切り替えは可逆です([戻り道](#戻り道)を参照)。
  step を `defineStep` に昇格させることは可逆ではありません。
  そのため、10 個目のあとではなく、最初の 1 個の前に持ち主の了承を得ます。
- **移行の途中でもスイートは走り続ける。**
  compat の step と型付きの step は、1 つの feature ファイルを共有します。
  「すべて型付き」を「走る」の前提条件にしないでください。
  `nuka run` は、`nuka check` がエラーを報告した scenario を拒否します。
  finding を直すか、残りが追いつくまで `--no-check` を渡します。
- **compat の glue を消すのは、型付きの置き換えが通ってから。**
  新しい step を書き、`nuka do` で走らせてから、古いものを消します。
- **直すのは `nuka check` と `nuka run` が報告したもので、勘ではない。**
  各 finding は、ファイルと `fix:` または `do:` の行を挙げます。
- **静かな `nuka run --probe` は、compat の Then について何も言っていない。**
  probe が再実行するのは、`mutates: false` を宣言した型付きの step だけです。
  probe に意味を持たせるには、先に Then を昇格させます。

移行で出会う事実です。

- `envFiles` は、スイートがすでに持っている env ファイルを指します(`KEY=VALUE` で、規則は docs/spec.ja.md の「Environment、secret」にあります)。
  空行でもコメントでも束縛でもない行は `env-file-skipped-line` です。
  対象ごとに 1 回走らせていたスイート(シェルのループや、プロファイルごとの CI ジョブ)は、1 回の run になります。
  各対象を `environments` で名付け、`nuka run --env a --env b` を渡します。
- `"type"` の無い `package.json` の下では、`.ts` ファイルは Node の警告つきで読み込まれます。
  `nuka check` はそれを注記 `package-type-missing` として報告します。
- `nuka run` は自分のレポートを書きません。
  cucumber messages を読んでいたフォーマッタや JUnit ベースの CI は、各 run のあとに `nuka report --format messages --out <path>` で描きます。
  Allure なら `--format allure` で同じことをします。
- `.feature` ファイルを探す走査は、どの深さでも `node_modules` と `.` で始まる名前のディレクトリを飛ばし、そのことを何も言いません。
- 待ってからやり直していた glue のループは、fixture の束の `poll` になります。
  その `timeout` は呼び出し全体の予算です(docs/spec.ja.md の「Context API」)。
- 後片付けをしていた全体の `After` hook は、fixture の teardown にできます。
  fixture の分割代入が読めないとき、または知らない fixture を挙げているとき、`nuka check` は `fixture-structural-violation` を報告します。
- capture を coerce する昇格済みのスキーマ(`{string}` に対する `z.coerce.number()`)は `capture-type-mismatch` ではありません。
  run はそれを受け入れます。

## 既知の限界

- hook 自身のネットワーク通信はどの step の境界にも属しません(どの step の `observed` にもカウントされません)。
- World の計測が見るのは World 自身の own データプロパティだけです。
  `#private` のフィールドは、構造上 `world.reads`/`world.writes` に現れません。
- 宣言された attachment のファイル内容は redact されません(trace や screenshot がすでに抱えているのと同じ正直な限界です)。
- `BeforeAll`/`AfterAll` の失敗は、stderr と exit code だけに報告されます。
  record は scenario ごとに書かれますが、これらの hook はどの scenario にも属しません。
  そのため、run レベルの hook 用の行き先はまだありません。

以下の違いは失敗しません。
スイートは走り、値や順序が cucumber-js の与えるものと違うだけです。
どれも、同じ glue を cucumber-js 13.2.0 と `nuka run` の両方で走らせて計測しました。
run の結果に頼る前に、それぞれを glue の中で探してください。

- `AfterStep` の hook は登録順に走ります。
  cucumber-js は登録の逆順に走らせます。
  `After` の hook については、どちらのツールも逆順です。
- hook の `result.message` は、エラーのメッセージだけです(`boom`)。
  cucumber-js は stack のテキストを与えます(`Error: boom` とその下のフレーム)。
  `result.exception` は設定されません。
- `{ timeout }` を持たない step は、`setDefaultTimeout` を一度も呼ばないスイートでは時間の上限を持ちません。
  cucumber-js は 5 秒でそれを失敗させます。
- `table.raw()` はコピーを返します。
  cucumber-js では、返った配列の行を変えると、あとで `table.hashes()` が返すものも変わります。
