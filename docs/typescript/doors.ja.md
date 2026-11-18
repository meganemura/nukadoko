# 既存のスイートを取り込む

> 原文は doors.md。

既存の JavaScript のスイートが TypeScript エンジンに入る 2 つの扉です。
1 つは cucumber-js の step 定義をそのまま実行する扉、もう 1 つは Playwright Test のスイートが型付き step とコードを共有する扉です。
スイートを一歩ずつ移す手順は、1 つ目の扉が [migration.ja.md](migration.ja.md)、2 つ目が [migration-playwright-test.ja.md](migration-playwright-test.ja.md) にあります。
Ruby エンジンには、どちらの扉もありません。

## Compat steps(移行の扉)

既存の Cucumber と Playwright のスイートは、import を 1 つ変更して nukadoko を導入できます:

```ts
// before: import { Given, When, Then } from "@cucumber/cucumber";
import { Given, When, Then } from "nukadoko/compat";
```

- Compat step は既存の pattern 構文と World(`this`)を維持します。
  nukadoko の harness が `page` と `request` を提供し、管理します。
  カスタム World クラスは、`setWorldConstructor` を使って nukadoko の基底クラスを拡張します。
  その World の構築中に throw すると、その scenario だけが失敗します。
  stderr には setup の 1 行が出て、scenario record は failed になり、step record は引用されません。
  同じ run の後続 scenario は実行され、messages の export は完了します。
  API は、よく使われる Given、When、Then、World、Before、After、AfterStep をサポートします。
  新しい需要が生じたときに、このサブセットを拡張します。
- `Given`、`When`、`Then` は、1 つの登録操作を示す 3 つの名前です。
  キーワードは登録時には意味を持ちません。
  Cucumber と同様に、実行時の意味は scenario 内の位置が決めます。
  pattern は素の cucumber-expressions 文字列または RegExp です。
  named capture の規律は typed step のものであり、ここでは要求しません。
  RegExp のサポートによって、正規表現を使うレガシー glue を受け入れます。
  cucumber-js の両方の呼び出し形、`Given(pattern, fn)` と `Given(pattern, { timeout }, fn)` にそのまま対応し、`timeout` は尊重されます。
  認識できないオプションキーは、登録時に例外を投げます。
  discovery はファイルを import し、各登録をそれを行ったファイルに帰属させます。
  pattern テキストが compat step を識別します。
  `nuka steps` は kind 付きで列挙し、`nuka describe` は契約がないことを示します。
  `nuka do` は名指し実行を拒否します。
  `defineStep` への昇格によって、単体 step の実行が可能になります。
- compat コードの `defineParameterType` と `config.parameterTypes` は、1 つのレジストリを使います。
  登録を config へ移しても pattern のマッチは変わらないため、チームはこの移動を早く行えます。
  例外は `preferForRegexpMatch` を設定する登録です(後述)。
  config が、それらの引退先です。
  transformer の `this` は、その scenario の World です。
  step と hook が動くのと同じオブジェクトです。
  transformer が返した Promise は、step が走る前に await されます。
  string の pattern でも RegExp の pattern でも同じです。
  compat の登録の `preferForRegexpMatch` は、cucumber-js と同じく、複数の型が一致する RegExp のグループに使う型を選びます。
  `config.parameterTypes` にはこのキーがないため、これを設定する登録は、RegExp の step がそれに頼っている間は compat コードに残ります。
  キーごと config へ移すと config のエラーになり、キーを外して移すと 2 つの型が一致する RegExp のグループは再び失敗します。
  2 つの型が 1 つの正規表現を優先する場合や、ある型が `{int}` のような組み込み型の正規表現を優先する場合は、`parameter-type-invalid` エラーです。
- 実行は 2 つの形をサポートします。
  自前で Playwright を起動する glue は、trace も page のログもないまま動き続けます。
  World のサブクラスは、その page と request を `this.page = ...` と `this.request = ...` で代入します。
  `this.page` と `this.request` は、`openPage()` や `openRequest()` が保存した値より先に、その代入した値を返します。
  代入した page には trace もスクリーンショットもありません。
  代入した request context を通して step が送ったリクエストは、それでも http.jsonl の `node:http` または `node:https` の行になります(docs/spec.ja.md の「Records」を参照)。
  `await this.openPage()` と `await this.openRequest()` は、harness の計測対象である page と request を返します。
  代入がないとき、対応する `openPage()` または `openRequest()` が解決する前に `this.page` または `this.request` を読むと、例外を投げます。
  混在 scenario の typed step は、同じ context と cookie を共有します。
  table は依存ゼロの薄い `DataTable`(raw / rows / hashes / rowsHash / transpose)として届きます。
  `table.hashes()` を呼ぶ glue が import の差し替えで壊れてはならないからです。
  docstring は素の string のままです。
  Before / After hook は、cucumber-js が受け付ける 3 つの書き方をサポートします。
  その書き方は、`Before(fn)`、`Before({ tags }, fn)`、`Before("@tag", fn)` です。
  `Before` と `After` は、`tags` と `timeout` に加えて `{ name }` を受け付けます。
  その文字列は登録に保存され、空でなければその呼び出しの `hooks` エントリにも載ります。
  Allure の fixture 名、run サマリの行、trace chunk のタイトル、hook 失敗時のメッセージは、その文字列をタイトルに使います。
  どの scenario で走るか、timeout、登録順は変わりません。
  `AfterStep` は `name` を受け付けません。
  cucumber-js の step hook の options にそのフィールドは無いからです。
  hook は cucumber 自身の hook 引数を受け取ります。
  hook は `@tag` または `not @tag` だけで絞り込めます。
  より複雑な式は、静かな誤マッチを防ぐために明示的に失敗します。
  hook は自分の step record を持たず、scenario record の `hooks` 配列に現れます。
  hook 内のネットワーク通信は、どの step の境界にも属しません。
  http.jsonl の行は scenario 全体で共有され続け、個々の hook 呼び出しに紐付けられることはありません。
  ただし Playwright の trace は違います。
  `this.openPage()` に触れた Before/After/AfterStep の個々の呼び出しは、それぞれ自分自身の trace chunk と `actions` のリストを持ち、同じ `hooks` 配列のエントリ上に記録されます。
  `trace`/`actions`/`truncated` は、step 自身の record と同じ形です(docs/spec.ja.md の「Records」を参照)。
  各 chunk は、step の chunk と sibling hook の chunk から独立しています。
  hook の呼び出しには、依然として `sections`/`polls` はありません。
  `section`/`poll` を呼ぶための fixture bag を hook が持たないからです。
  hook 自身が明示的に呼んだものではなく trace chunk 自体から読み出される `actions` だけは、この制約の影響を受けません。
  `AfterStep` は、同じ 3 通りの呼び出し形と `@tag` / `not @tag` のフィルタを共有します。
  Before/After は scenario 全体を挟みますが、`AfterStep` は実行された pickle step ごとに 1 回動きます。
  この scenario がそれより前の step の失敗によってスキップした step は始まってすらいないため、`AfterStep` にとっての「後」はそこには存在せず、その step については何も現れません。
  タグが一致しない hook にも同じ規則を使います。
  `hooks` 配列内の各 `AfterStep` エントリは `step_index` を運びます。
  これは、その record 自身の `steps` 配列の中での実行された step の 0 始まりの index であり、レポートがエントリ同士を区別できるようにするためのものです。
  Allure と cucumber-messages の両方がこれをそのまま運びます。
  hook 引数の `result.status` は、`@cucumber/messages` の `TestStepResultStatus` 文字列値を使います。
  `nukadoko/compat` は、同じ enum を `Status` として re-export します。
  したがって、`result.status === Status.FAILED` と書かれた glue は正しく import され、比較できます。
  `After` と `AfterStep` は `result.duration` も受け取ります。
  これは cucumber の `Duration`(seconds と nanos)で、`result` が表す step 自身の開始から終了までを測ったものです。
  その結果が失敗のとき、`result.message` は executor がすでに記録している失敗の文言で、`error` は失敗が throw だったときの投げられた値です。
  `Before` は `result` も `error` も受け取りません。
  `error` は `After` と `AfterStep` では step が成功したときもキーとして存在し、その値は `undefined` です。
  cucumber-js が `result` を渡すときにはそのキーも代入するからです。
  `AfterStep` は加えて `pickleStep`(直前に走った pickle step)と `testStepId`(その step の step record id)を受け取ります。
  この id は `testCaseStartedId` と同じ種類の身代わりです。
  executor がすでに持っている安定した id であり、cucumber-messages のストリームが後から割り当てる id ではありません。
  `SKIPPED` が一致する場所は 1 つだけです。
  walk が中止した scenario の `After` hook で、その scenario の step は全部は走っていません(docs/spec.ja.md の「人と一緒の walk」を参照)。
  この enum の他のメンバー(`PENDING`/`UNDEFINED`/`AMBIGUOUS`)は決して一致しません。
  nukadoko には、hook 自身の result が運びうる pending、undefined-step、ambiguous-match のいずれの概念もないからです。
  移行した glue は、これらの値を比較する分岐を通らず、この挙動は compat gap ではありません。
  `BeforeAll`/`AfterAll` は、scenario ではなく run 全体を挟みます。
  `{ timeout }` と `{ name }` を受け付け、`tags` と `on` は拒みます。
  `on` は hook を動かすプロセスを選ぶオプションで、nukadoko にはその選択が無いからです。
  World を持たず、scenario が 1 つも選ばれなければ実行されません。
  空でない `name` は、失敗メッセージのタイトルになります。
  これらの hook は scenario record に属さないため、exit code を通じて報告します。
  `setDefaultTimeout` は、自分の timeout を宣言していないものすべてに既定値を与えます。
  負の値は無制限を意味し、cucumber-js と同じです。
  `setDefaultTimeout(-1)` と、step や hook の `{ timeout: -1 }` は制限を切ります。
  0 は制限時間として効きます。
  呼ばないか、負の値で呼べば、step は cucumber の 5 秒という上限を持ち込む代わりに無制限のままになります。
  移行しただけの理由で、遅いスイートを失敗させてしまわないためです。
- nukadoko は常に World を計測します。
  すべての compat step の step record は、その step が World のどのキーを読み書きしたかをアクセス順で記録します(`this.foo` が隠していたデータフローです)。
  計測面はバッグの own データプロパティです。
  構造上、`#private` の状態は計測に含まれません。
  `defineWorld({ key: zodSchema })` は、キー単位でバリデーションを有効にします。
  schema に失敗した書き込みは step を失敗させ、write として記録されません。
  `class MyWorld extends defineWorld({...})` は `this` に型を付けます。
  cucumber 自身の `attach` / `log` / `link` / `parameters` は予約キーです。
  計測されず、宣言もできず、上書きは黙った破壊の代わりにエラーになります。
  `parameters` は config の `worldParameters` で、デフォルトは `{}` です。
  `page` と `request` はバッグのフィールドではなく、harness の getter です。
  `defineWorld` は step ファイルの import 時に、どちらの名前も拒みます。
  `nuka check` はその拒否を `step-file-import-failed` として報告し、`nuka run` は同じメッセージで止まります。
  メッセージはフィールド名を含みます。
  サブクラスは、これまでどおりそれらを代入できます。
  `await this.openPage()` と `await this.openRequest()` は、これまでどおり harness のオブジェクトを返します。
- `this.attach` と `this.link` は cucumber-js に従います。
  `attach` は文字列、`Buffer` または `Uint8Array`、readable stream のいずれかを受け取ります。
  media type が `base64:` で始まるとき、その文字列は base64 であり、ファイルには復号したバイトが書かれます。
  第 2 引数はその media type か、`{ mediaType, fileName }` です。
  `fileName` があるときは、それが step record の下に書かれるファイルの名前です。
  media type を省いた文字列または buffer は `text/plain` として書かれます。
  stream は promise を返すので、step はそれを await する必要があります。
  media type のない stream は例外を投げます。
  バイトは stream が終わるまで分からず、型も渡されていないからです。
  `link` は URL を 1 つ、または複数受け取ります。
  各引数は `declared` の link として 1 件ずつ記録され、表示名は付きません。
- harness はブラウザと request のオブジェクトを所有します。
  したがって、compat step はコードを変更せずに計測済みの step record を得ます。
  この record は status、timing、trace、screenshots、HTTP log を含みます。
- compat step には、型付きの契約、step record 内でバリデーションされた `result`、単体 step の CLI 実行がありません。
  よく使う step を `defineStep` に昇格させると、これらの性質を 1 step ずつ追加できます。
- 監査によって、この扉の幅を計測しました。
  公開されている cucumber-js のスイート 8 本を、この扉に対して監査しました。
  glue はテキストとして読み、実行しませんでした。
  当時はどのスイートも import の差し替えだけでは通りませんでしたが、そこで見つかった障害をふさいだことで、8 本のうち 2 本はその後、glue の中に拒まれるものが何もない状態になりました。
  残りが何を必要とするかは [docs/typescript/migration.ja.md](migration.ja.md) に列挙されています。
  監査から 1 つの規則を定めました。
  compat がサポートしない挙動は、import 時または最初の run で失敗する必要があります。
  移行するチームは、大きな声の失敗には対処できますが、静かな失敗は見えません。
  だから、黙って振る舞いを変えてしまう抜けは、機能が欠けていることが食ってきた時間よりも多くの信頼を食います。
  import の失敗と下の所見は、この規則を満たします。
  値の水準の違いはまだいくつか残っています。
  それらは失敗しないので、計測済みのものを 1 つずつ [docs/typescript/migration.ja.md](migration.ja.md) の「既知の限界」に挙げています。
- 明示的な失敗は、静的な所見と step の実行が必要な失敗に分かれます。
  `nuka check` は、静的な所見だけを報告します。
  **`nuka check` が報告できる失敗**: import が例外を投げる step ファイルは `step-file-import-failed` エラーになります。
  原因には、`nukadoko/compat` が export しない名前の値としての使用、ESM glue 内の CommonJS `require`、深い subpath の import があります。
  単一の `@tag` / `not @tag` を超える hook のタグ式は、`unsupported-hook-tag-expression` エラーになります。
  どちらも、何かが実行される前に、そのファイルのテキストだけから分かります。
  その隣にはさらに 2 つの所見があり、どちらも 1 つのファイルの中身についてではなく discovery 自身が歩く範囲についてのものです。
  `.cjs` または `.cts` のファイルが `featuresDir` の下にあるときの `step-file-unsupported-extension`(nukadoko がそれを import しない理由は前述のdocs/spec.ja.md の「型付き step」を参照)と、歩いた結果として試せるものが何もなかったときの `no-step-files-found` です。
  どちらも、実際に何を見た結果なのかを名指しします。
  所見が嘘のとき、読み手がそれに気づけるようにするためです。
  注記 `pattern-unbound` がスキャンしたディレクトリを名指すのも、同じ理由です。
  `undefined-step` の所見は、引用符の付け忘れも示せます。
  同じ位置に合う登録済み pattern が 1 つあり、その capture がすべて `{...:string}` parameter である場合、所見は step と pattern を名指しし、書き直した Gherkin の行を示します。
  その行を説明できる pattern が 2 つ以上ある場合、どれを選ぶかは書き手が決めるため、このヒントは表示されません。
  **`nuka check` が報告できる失敗には done callback も入ります**。
  コードは `done-callback-arity` です。
  compat の hook が上限を超えるのは、Before、After、AfterStep が引数を 2 つ以上宣言したときと、BeforeAll、AfterAll が引数を 1 つ以上宣言したときです。
  マッチした compat step が上限を超えるのは、関数の引数の数が、その行の capture に table または docstring を足した数を超えるときです。
  その数は関数とマッチした行から決まるので、この所見の結果は 1 通りにしかなりません。
  マッチしていない step については黙ります。
  capture の数は、その step を選んだ行から決まるからです。
  **`nuka run` だけが報告できる失敗**: step や hook が `"pending"` / `"skipped"` を返す場合です。
  その値は、関数が実行中に返すものに依存します。
  import の解析では識別できません。
  **どちらでもない(gap ではない)こと**: 型注釈にしか使われていない、あるいは import はされたが一度も参照されない名前は、nukadoko がそのファイルを import するより前に esbuild によってコンパイル済み出力から取り除かれるため、その import は実行時には実際には一度も起きません。
  glue は書かれたとおりに実行されます。
  `tsc` はその名前を compat が export しているものに対して解決するので、欠けている名前はコンパイルエラーであって実行時のエラーではありません。
  監査がこの分類で見つけた 2 つの名前、`IWorldOptions` と `ITestCaseHookParameter` を export する価値があったのはまさにそのためです。
  `nuka` がそれらの失敗を一度も見なかったとしても、その代償は利用者の実行ではなく利用者の型検査が払っていました。
- 恒久的な設計規則を、すべての移行作業に適用します。
  動いている compat 資産は、チームが nukadoko を導入したあとや、別の資産を typed step へ移したあとも動く必要があります。
  移行途中の「住まいが 2 つある」状態(support コードに登録された parameter type と config に住む parameter type、World のバッグと typed の result の併存)は、禁止するのではなく受け入れます。
  ただしそれらは必ず 1 つの実体を共有し、分散は隠さず `nuka check` が可視化し、個々の移行の一手は意味を変えないものに限ります(だから早く安全に動かせます)。
  扉は両方向に開きます: import を元に戻せることは維持されます。
- [docs/typescript/migration.ja.md](migration.ja.md) は、既存の cucumber-js と Playwright のスイートに対する手順を示します。
  [docs/typescript/upgrading.ja.md](upgrading.ja.md) は、既存の nukadoko プロジェクトを新しいリリースへ移す方法を説明します。

## 第二の扉: Playwright Test のスイート

最初の扉は、cucumber-js の上に組み立てられたスイートで import を変更する方法です。
Playwright Test に対して直接書かれたスイートには、その import がありません。
テストは `test("...", async ({ page }) => {...})` を使い、リダイレクトする glue レイヤーもありません。
このスイートには、別の移行方法が必要です。

[docs/typescript/migration-playwright-test.ja.md](migration-playwright-test.ja.md) は、この扉の手順を示します。
`docs/typescript/migration.ja.md` は、最初の扉を扱います。
Playwright Test のスイートには compat step、World、Cucumber hook がないため、2 つの文書は異なる読み手に向けたものです。

**実装を共有します。**
操作を spec ファイルから通常の非同期関数へ移します。
この関数は、Playwright のオブジェクトだけを受け取ります。
spec と型付き step の `run` は、どちらもこの関数を呼びます。
各 runner は、自分のファイルだけを読み込みます。

```
e2e/cart.spec.ts  ──▶  features/steps/lib/cart.ts  ◀──  features/steps/add-item.ts
   (Playwright)              (plain functions)               (nukadoko)
```

矢印は意図的に一方向を向いています。
Playwright のスイートは nukadoko を import しません。
移動後も、Playwright とリポジトリ内の関数だけに依存します。
compat の移行を戻すには、import を元に戻します。
この移行を戻すには、feature ファイルと step を削除します。
依存先に nukadoko が含まれないため、Playwright のスイートは変わりません。

共有 API の形によって、この構成が成り立ちます。
`page`、`context`、`request`、`baseURL` は、どちら側でも Playwright のオブジェクトです(docs/spec.ja.md の「Context API」を参照)。
どちらの呼び出し元も、これらのオブジェクトを受け取る関数を使えます。
adapter、wrapper、re-export は必要ありません。

この API 境界より上にあるものは共有しません。
spec は `step.run(bag, args)` を直接呼び出してはいけません。
この呼び出しは、step が Playwright の fixture 名だけを使う間しか動きません。
step が `call`、`section`、`resultOf`、`requireEnv` を使うと失敗します。
これらの fixture は、型付き step の価値の多くを提供します。
「Fixtures」で説明した型付けの制約があるため、spec は fixture map も共有できません。

契約は、共有ユニットに置きます。
step の `args` と `returns` は通常の zod schema です。
関数のファイルが schema を export し、step が schema を宣言できます:

```ts
// features/steps/lib/cart.ts
export const openCartReturns = z.object({ id: z.string() });
export async function openCart(request: APIRequestContext) { ... }

// features/steps/open-cart.ts
export default defineStep({ returns: openCartReturns, run: ({ request }) => openCart(request) });
```

spec と step は 1 つの定義を import するため、両者の形は一致し続けます。
共有ファイルは Playwright と zod だけに依存するため、依存の向きは変わりません。

この移行によって、nukadoko の 2 つの経路が開きます。
`nuka run` は feature ファイルに経路を固定し、`nuka do` は各 step を単体で実行します。
既存のスイートがすでに信頼する操作は、agent が探索に使う語彙になります(docs/spec.ja.md の「単体 step」を参照)。

2 つのツリーは、1 つのリポジトリに置けます。
チームは、両者を並べて配置できます。
または、spec がすでにあるディレクトリの *内側* に `featuresDir` を配置できます。
Playwright のスイートが主要な資産である場合、2 つ目の配置は移動を少なくします。

```
e2e/
  cart.spec.ts          <- Playwright finds this
  lib/cart.ts           <- shared, owned by neither runner
  nukadoko/             <- featuresDir
    cart.feature
    steps/add-item.ts   <- Playwright does not find this
```

各 runner は、認識するファイルだけを読み込みます。
Playwright は、自分の `testMatch` に一致するファイルを集めます。
step にちなんだ名前の step ファイルは一致しません。
discovery は、`featuresDir` の下にある各 `.ts`、`.mts`、`.js`、`.mjs` ファイルを import します。
そのディレクトリの外にある spec は、discovery の範囲外です。
これらの命名規則と配置規則は衝突しません。

nukadoko は、2 つの誤った配置を明示的に報告します。

discovery は、`featuresDir` の **内側** にある spec を import します。
Playwright の `test()` は Playwright runner の外では動かないため、import が失敗します。
`nuka check` はファイルを名指しし、Playwright のメッセージを含めます。
`run` と `do` は、他の壊れた glue と同様に実行を拒否します。

**spec のように名付けられた** step ファイルは、別の衝突を起こします。
ファイルの basename が step 名を定義します。
したがって、`open-cart.spec.ts` は最初の step の pattern を持つ `open-cart.spec` という 2 つ目の step を定義します。
`nuka check` は `ambiguous-step` を報告し、両方の step を名指しします。
1 つの pattern が複数の step にマッチすることがエラーです。
ファイル名を変更すると直ります。

どちらの配置でも、共有ファイルは `featuresDir` の外に置きます。
モジュールは step を定義しないため、discovery が import しても問題はありません。
しかし、その場所は既存のスイートが共有ファイルを所有することを示します。

