# nukadoko 仕様

> nukadoko(あなたの Gherkin のための生きたぬか床): 型付きの step、receipt、そして agent-first な CLI。

> 原文は spec.md。相違があれば原文が正。

Status: M1(engine core)実装済み(`steps`/`describe`/`do`/`run`/`check`/`init`/`scaffold`、session、environment、secret)。
M2(compat、後述)も実装済み(`nukadoko/compat`、typed World の計測、移行ガイド)。
実世界での検証ゲートは、いまや両方とも実行済みです。
typed step を実際の feature ファイルに対して起草したゲートと、compat の扉を実際の cucumber-js の glue に対して監査したゲートです(後述)。
まだ 0.x で、M3 以降のうち Allure emitter と messages emitter はどちらも実装済みであり、sign-off(`nuka accept`)と M5 の両方の skill も実装済みです。
`nuka check` における compat gap 検出(migration skill 自身の前提条件)も実装済みで(「Compat steps」と docs/migration.ja.md の「ダッシュボードは `nuka check`」を参照)、M1-M5 を締めくくります。

## nukadoko とは

nukadoko は Gherkin を実行する agent-first のエンジンです。
人間は耐久性のある成果物(feature ファイル、型付き step の定義、sign-off の記録)を書きレビューし、agent がそれらを実行します。
実行系はすべて agent の試行錯誤ループのために最適化されており、あらゆる step が型付きの契約を持ち、あらゆる step が CLI から単独で実行でき、あらゆる実行が残す receipt は agent ではなくツールが書いたものです。
agent には**偽造できない** receipt という意味ではありません。
shell アクセスを持つ agent は、receipt を含めどんなファイルでも書けます。
そうではなく、agent に頼んで作ってもらう必要が最初からなかった receipt だということです(詳しくは「Out of scope」を参照)。

Agent-first は設計上の制約であり、スローガンではありません。
agent は、介助なしにループ全体を完了できなければなりません。
語彙を発見し(`nuka steps --json`)、契約を読み(`nuka describe`、スキーマは JSON Schema として)、1 つの step を実行し(`nuka do`、receipt は stdout に、意味のある exit code とともに)、バリデーション済みの結果を読み、次の呼び出しを決めます。
語彙に操作が欠けているときは、agent が新しい step を scaffold して実装し、人間がその PR をレビューします。
あらゆるインターフェースは機械可読な形(`--json`)を必ず持ち、リッチな人間向けレポートは Allure に委ねられます。

この制約からくる帰結の一つは、このツールがどこへ育つかを左右するため、それ単独で述べておく価値があります。
E2E 実行は、unit test にはない形で高くつきます: ブラウザ、実物のターゲット、分単位の時間です。
だから、シナリオのどれだけを**実行せずに**誤りだと判定できるかが、実質的には誰にとってもそのシナリオへの反復の速さであり、そして安価なコマンドの積み重ねでループが回る agent にとっては、それはそのまま自らの作業を正す速さに直結します。
この仕様が求める宣言はどれも、その代価の一部をこの形で払っています: `pattern` と `args` は `check` がブラウザを開く前に行を拒否することを可能にし、`mutates` は Then を疑うことを可能にし、`from` は、その順序では失敗するしかない step の並びを持つ scenario を拒否することを可能にします。
したがって `nuka check` が判定できる範囲を広げることは、ここでは便宜ではなく一級の目標であり、失敗した run のたびに常に問われるのは、check がそれをあらかじめ捕まえられたはずかどうかです。
その限界を決めるのは野心ではなく誠実さであり、`check` は結末が一つしかありえないことだけを主張します、推測で判定する check は、そうでない check まで読み飛ばすよう人を慣らしてしまうからです。

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

discovery は `featuresDir` を歩き、`.ts` / `.mts` / `.js` / `.mjs` のすべてのファイルを対象にします(ファイルがどの拡張子であっても、step 名はその拡張子を取り除いた名前になります)。
`node_modules` とドットディレクトリ(`.git`、`.nukadoko`、エディタ自身の `.vscode` など)はどの深さでもスキップし、`.d.ts` / `.d.mts` も除外します。
これらは型宣言であって step 定義ではないためです。
`.cjs` ファイルは名指しできる程度には歩きますが、インポートはしません。
nukadoko は ESM-only であるため(同じ CommonJS の go/no-go については後述の「Compat steps」を参照)、`nuka check` はそれを `step-file-unsupported-extension` として報告し、そこで定義されていたかもしれないものが説明のつかない `undefined-step` として現れることを防ぎます。
`featuresDir` を広く設定する(たとえばリポジトリのルートなど)と、この歩く範囲も同じだけ広がります。
その木の中のどこかにあるビルド成果物であっても、名前が上記 4 つの拡張子のいずれかで終わっていれば glue として読み込まれる可能性があります。
`node_modules` とすべてのドットディレクトリは、`featuresDir` をどれだけ広く設定していても除外され続けます。

```ts
import { defineStep } from "nukadoko";
import { z } from "zod";

export default defineStep({
  pattern: "a project {name:string} exists",  // named capture, see below
  description: "Create a project and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  mutates: true,                               // default true; see keyword semantics
  async run({ request }, args) {
    const res = await request.post("/projects", { data: args });
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
  ただしこの制約が縛るのは group の構文であって、パラメータ自身ではありません。
  自分の regexp が optional なカスタム parameter type(`( from '…')?` か空にマッチする `{dir:from-dir}` など)は合法で、「末尾の場所句だけが違う同じ step」を 1 つの定義に畳む正規の方法です(args 側のキーは `.optional()` にします)。
  カスタム型を使わない場合は、変種ごとに別の step 定義が必要になります。
- エイリアスは、args のレベルで真に交換可能な文(キー集合も `run()` の挙動も、どちらの言い回しにマッチしても同じ)のためのものです。
  `run()` がどちらの変種にマッチしたかを知る必要がある場合(挙動が言い回しそのもので分岐する場合)は、キー集合が偶然一致していても、変種ごとに別の step にします。
  1 つのエイリアスにまとめてしまうと、その分岐がレビュアーから見えなくなります。
- 複数形: 純粋な接尾辞の複数形(`message(s)`)には cucumber-expressions 純正の optional text `(s)` を使い、エイリアスは不要です。
  名詞自体の形が変わる場合(末尾に `s` が付くだけではない場合)は、代わりに `patterns` エイリアスを使います。
- `args` / `returns` は zod のスキーマで、実行境界でバリデーションされます(args は実行前、returns は実行後)。
  バリデーションの失敗は失敗した実行として扱われ、result は保存されません。
  キャプチャは parameter type によって型強制され(`{int}` → number、カスタム型はそれぞれの transformer による)、そのあとスキーマが契約になります。
  この対応関係は双方向に静的にチェックできます(`nuka check`)。
  スキーマのキーを持たないキャプチャはエラーです。
  ある行の何によっても埋まりようのない **required** なスキーマキーも同様にエラーです(キャプチャも table/docstring も `from` もない)。
  その行は args のバリデーションに失敗する以外にありえないからです。
  この逆方向は、キーが何かツールに見えない方法で埋まっているかもしれないという理屈のもと、しばらく未チェックのままでした。
  `from` が残る方法を可視化することでその隙間を埋めたため、残っているのは単に説明されていないだけでなく、正真正銘埋まりようのないものです。
- step に付いた data table や docstring は、名前付きキャプチャが消費せずに残した唯一の必須 args キーに結び付きます(table は `string[][]` として、docstring は `string` として)。
  他のものと同様にスキーマでバリデーションされます。
  Gherkin の table が初めて型を持つことになります。
  attachment が存在するのに未消費の必須キーが 0 個または複数ある場合は `check`/`run` のエラーになります。
  予約されたキー名はありません。
- `from` は、pattern がキャプチャしなかった args キーの値がどこから来るかを宣言します。
  `from: { projectId: [createProject, "id"] }` は「`projectId` は、この scenario 内で以前 `createProject` が返した結果の `id` である」という意味になります。
  executor は args のバリデーションより前にこのキーを埋めるので、キーは required のままにでき、スキーマはその step が実際に何を求めているかを言い続けられます。
  値になれるのはキー名だけで、決して変換ではなく、1 つのキーは互いに排他的な複数の生産者を列挙できます。
  なぜその制限こそが要点なのか、候補がどう解決されるのか、そしてキー名だけでは足りないときにどうすればよいかは「step の連鎖」を参照してください。
- `returns` に何を入れるかが、失敗したときに何を手がかりに診断できるかを決めるので、「後続の step が参照するものを返す」を設計の指針にするのは誤りです。
  その指針は、この step 自身の正しさが依存しているのに下流の何にも読まれない値(計算した日付、選んだ id、送信前に解決した名前)をすべて落としてしまいますが、それらこそまさに run が失敗したあとに receipt が問いただされる値です。
  返せば receipt 上にバリデーション済みの事実として載り、「実際には何を送ったのか」という問いに答えがあります。
  返さなければ、その答えは他人のシステムが書いたエラーメッセージから再構築するしかありません。
  これは `observed` と `sections` 自身の「計測して残す」という理屈を、step 自身が埋める唯一のフィールドに適用したものです。
- `visible: false`、`count: 0`、空文字列のように不在を主張する観測は、存在を主張する側には無い曖昧さを、まさにその形で抱えます。
  対象が本当にそこに無いのか、ページがまだ描画を終えていないだけなのかのどちらかであり、step が別途言わない限り、この 2 つの状況は receipt 上で同じ値を生みます。
  `returns` が不在を運びうる step は、その隣に、読み取り自体が妥当だったことを証明する何かを運ぶべきです。
  つまり、不在が早すぎる問い合わせの症状ではなく本物の答えである状態に、ページが達していたことです。
  それが無ければ、レビュアーが receipt から立てられるどの仮説も等しくそれと整合してしまい、それが反証不可能ということの実際の意味です。
  存在の主張にはそうした連れ添う証拠は要りません。
  `visible: true` は、その読み取りが描画済みのページに着地したことをそれ自体で証明します。
  隠れた要素も未描画の要素も `true` を生み出せないからです。
  肯定の主張はそれ自身を保証し、否定の主張はそうしないという、この非対称性こそが、両者に同じ規約を当てはめるのではなく別々に扱う理由です。
  これが最も効いてくるのは、一見無関係に見える場面です。
  「条件が満たされない限り非表示」と書かれた受け入れ基準は、未描画のページが生み出すのと同じ `false` によって満たされてしまうため、それを主張する scenario は、ページが一度も読み込みを終えないまま green になり得ます。
  間違った理由で green になったのか正しい理由で green になったのかは、receipt に readiness の証拠が無い限り見分けが付きません。
  受け入れ基準を、起きたか起きなかったかのどちらかである実行に結び付けることが目的のツールは、それを些細な隙間として扱うわけにはいきません。
  それこそがその隙間です。
- `mutates`(デフォルトは `true`)は、その step が触れる範囲のどこかで状態を変更するかどうかを表します。
  読み取り専用の step は `mutates: false` を宣言します。
- `rationale` は任意で、デフォルト値を持ちません。
  省略すると `Step.rationale` は `undefined` になり、`pattern` と同じ慣習です。
  `description` とは別の問いに答えます。
  `description` はその step が何をするかで、`nuka steps` が一覧するのはこの情報であり、agent はそれを見てどの step を呼ぶか選びます。
  `rationale` はなぜこう実装したのか、何を試して何を捨てたのかで、agent が「この step を書き換えてよいか」を決める前に必要とする情報です。
  `nuka steps` の一覧には決して現れず、表示するのは `nuka describe` だけです。
  receipt にも現れません。
  receipt は 1 回の実行を記録するものであり、rationale はその step のどの receipt でも同一になる契約の属性であって、実行が生み出したものではないからです。
- `run` の本体は、自分が分割代入した fixture の上で自由に書ける TypeScript です。
  合成とは、別の step モジュールをインポートし、同じ fixture bag でその `run` を呼び出すことです。
  共有ヘルパーは通常のモジュール(例: `features/steps/lib/`)に置きます。
- 意味的な正しさ(実装が description と pattern の主張どおりに動くかどうか)は、ツールではなく PR レビューによって保証されます。
  `steps/` は CODEOWNERS で保護してください。

### Context API

step の `run` は **fixture bag** を受け取ります。
プレーンな分割代入パターンで名前を並べたものです: `run({ page, section }, args)`。
実際に分割代入された名前だけが構築されます。
`page` も `context` も名指さない step は、その step に関する限りブラウザを一切起動しません。

この最後の一文はこの節の設計目標ではなく、本当の目標から導かれる結果です。
`run({ page }, args)` は「page をください」の省略形ではありません。
`check` が `run` を一度も呼ばずにそのまま読む、同じオブジェクトリテラルです。
`pattern`/`args`/`returns`/`from` を実行せずに読んでいるのとまったく同じです。
したがって `page` を名指すことは step が実行時に行う動作ではなく、ファイルを書く時点で行う宣言であり、実行されるより前から読めます。
`check` はその宣言を、呼び出すのではなく `run` 自身のソーステキストを解析することで読み、実際に構築されるものは同じ宣言に従うので、両者が食い違う余地がありません。
step はファイルの冒頭で「宣言していない何かが要る」と主張することができません。
なぜなら宣言こそが実際に構築されるものだからです。
これは `from`(「step の連鎖」を参照)がすでに step 自身の *出力* について確立した形(実行を事後に説明するのではなく駆動する静的な宣言)を、ここでは *資源* に対して適用したものです。
Playwright の fixture も同じ分割代入の構文を使いますが、それはこの設計の理由ではありません。
Playwright にとってこのパターンはそれ自身の runner への構築命令ですが、nukadoko にとってはまず `check` が読む宣言であり、構築命令であることはその結果にすぎません。

fixture の名前:

- `page: Page`: session の storageState から復元された Playwright の Page で、設定された baseURL が browser context に渡されるため `page.goto("/path")` はそれを基準に解決されます。
  ブラウザが起動するのは step 自身の bag が構築される時点で、しかも `page`(または後述の `context`)がその step が分割代入した名前のひとつであるときだけです。
  それより早く起動することはなく、どちらも名指さない step では起動しません。
- `context: BrowserContext`: `page` がすでに属している `BrowserContext` そのもので(`page.context()`)、2 つ目が作られることはありません。
  2 枚目のタブが要る step のために存在し、executor が公開していない `browser`(後述)に手を伸ばさずに済みます。
- `request: APIRequestContext`: session の cookie を持つ Playwright の APIRequestContext です。
  baseURL はここでも任意で、上の `page` と同じです。
  複数のホストへ絶対 URL だけで話すスイートには述べるべき単一の baseURL がなく、nukadoko はこの fixture のためだけに意味のない baseURL を config に書かせません。
  baseURL が未設定のまま step が相対パスを渡した場合、その失敗は Playwright 自身のものです。
  nukadoko はそれを先回りして防ぐために URL 解決規則を自前で実装しません。
- `env`: 設定された envFiles から得られる環境変数です(読み取り専用)。
  これは便利機能ではなく、決定論(プロセス環境は決してマージされない)と secrets の赤塗り(redact できるのは nukadoko 自身がロードした値だけ)が強制される場所です。
- `requireEnv(name)`: `env[name]` と同じ値を返しますが、必須の変数を読む step がそれぞれ自前で書く羽目になっていた存在チェックを肩代わりします。
  `undefined` を返すことは決してなく、代わりに投げることで常に `string` を返します。
  空文字列も欠落として扱われます。
  envFile の `KEY=` という行は「キーが省略された」ではなく `""` にパースされ、その変数を必須と宣言した step にとってはどちらの場合も等しく壊れているからです。
  エラーはキー名だけを名指しし、値は決して含みません(欠落した値には示すべき値がなく、値を一切運ばない形は後になって redaction の抜け穴にもなり得ません)。
  そしてどの envFile を直せばよいかは言えません。
  この fixture が見るのは常にマージ済みの結果だけで、`config.envFiles` のリストを見ることは決してないからです。
  すべてのキーを一度に欲しい稀な step のために `env` は残ります。
  `requireEnv` に渡した名前は、その呼び出しが値を見つけた場合も投げた場合も、読み取った順に重複なく receipt の `required_env`(「Receipt」を参照)に記録されます。
  同じ値を `env` から直接読んだ場合はそこには残りません。
  そちらはプレーンなオブジェクトであり、ライブラリはそこに一切関与しないからです。
- `baseURL`: 設定された baseURL です。
  自分で URL を組み立てる、まれな場合のためのもので、よくある経路には上記のとおり最初から通してあります。
  `config.baseURL` が未設定のときは `undefined` になり、絶対 URL だけのスイートにとってそれは正当な状態であって、エラー状態ではありません。
- `resultOf(stepModule)`: 現在の scenario 内でその step が直近で成功した実行の、バリデーション済みの result です。
  `nuka do` の下では、あるいはその step がまだ成功していない場合は `undefined` になります。
  これは scenario 経路のデータチャネルであり、意図的に World ではありません。
  そこには何も書き込めず、読み取れるのは `returns` のスキーマを通過した結果だけで、依存関係は他の step モジュールへの目に見える `import` になります(その step 自身のスキーマによって型付けられ、diff の中でレビューできます)。
  「その listing は閉じている」のような feature の一文は、その参照先がバリデーション済みの結果を生成した範囲でのみ実装できます。
  `from`(「step の連鎖」を参照)は同じ読み取りを宣言的な形にしたものであり、まず手を伸ばすべきはそちらです。
  `resultOf` に残るのは、キー名では表せない読み取りです。
  discovery が登録しなかった `Step` を渡すと、`undefined` を返す代わりに投げます。
  その規則がどんな間違いを捕まえるためのものかは「step の連鎖」を参照してください。
- `section(label: string): void`: 実行がその名前の段階に到達したことを記録します。
  同期的で、返り値はなく、対になる「終了」呼び出しもありません。
  呼び出しはすべて、呼ばれた順で receipt の `sections`(「Receipt」を参照)に追加され、一度も呼ばない step には `sections` キー自体が現れません。
  これは `used` と同じ慣習です。
  区間を囲む形の関数(`section(label, fn)`)ではなく裸のマーカーにしてあるのは意図的です。
  区間を囲む形にすると、入れ子や早期 `return`、その境界をまたぐ `await` が何を意味するかをすべて決めなければならなくなりますが、それはこの API が答えようとする問い(実行がどこで止まったか。止まったブロックがどんな形をしているかではなく)には要りません。
- `await poll(fn, { description, timeout, interval })`: 求められてはいるがまだ存在しない状態のための submit-poll-fetch ループです。
  `fn` はその状態になるまで `undefined` を返し続け、`undefined` でなくなった最初の値を `poll` が返します。
  `timeout` の予算が先に尽きた場合は、代わりに `PollTimeoutError` を投げます。
  完了した呼び出しはすべて、何回試したか、どれだけ待ったか、どう終わったかとともに receipt の `polls`(「Receipt」を参照)に記録されます。
  `fn` が何を poll するかは実装の詳細ではなく契約上の選択です。
  観測対象自身の存在であってはなりません。
  正しい合格状態が不在であるような対象は、その条件の下では、単にまだ描画されていないだけの対象と見分けが付かなくなり、存在を poll してしまうと `fn` がその step の存在意義である答えを返すことが原理的に不可能になるからです。
  代わりに poll すべきは、対象についての判定をそもそも可能にする何かです(ローディングフラグが false になる、カウントが `undefined` でなくなる、データが届き次第ページが無条件に描画する何か、など)。
  そして対象自体を読むのは、それが解決してからにします。
  `page.waitForSelector` や `waitForLoadState` を通じてブラウザに対して直接取る待ちは、同じように待ちますが、あとに何も残しません。
  `poll` を通すことで初めて `at`、`attempts`、`waited_ms`、`outcome` が receipt に載り、それが事後になって「最初の試行で解決し待ちは何もしなかった」のか「4 秒かけて解決した」のかを見分ける唯一の方法になります。
  これは、Allure emitter がすでにその `declared:` という接頭辞で引いている、自己申告か計測かという同じ線引きです(「Allure emitter」を参照)。
  ここでは、ツールが計測した待ちと、Playwright の内部で見えないまま起きた待ちとの間に、その線が引かれています。
- `evidence.attach(name, body)` / `evidence.path(name)`: この一覧の残りが埋めていなかった唯一の穴です(上のどの fixture も harness が自分で集めるものを返すだけでした)。
  API レスポンスの生ログ、DB のスナップショット、生成したファイルの中身のような、step にしか作れないアプリ固有の証跡を足す口は、これまで存在しませんでした。
  `attach` は `body`(`string | Uint8Array`)をこの実行自身の evidence directory に書き込み、receipt の `evidence.attachments`(「Receipt」を参照)に記録します。
  同じ `name` で 2 回呼んでも両方のファイルが残り、最初のファイルを上書きすることはありません。
  `path` は Playwright 自身の `testInfo.outputPath()` に当たり、同じ directory の下に衝突しない絶対パスを、何も書き込まずに払い出します。
  receipt に載るのは、実行が終わるまでに step が実際に書き込んだパスだけです(`path()` を呼んだだけで何も書かれなければ、何も載りません)。
  この 2 つが別々の fixture ではなく 1 つのオブジェクトにまとまっているのは、どちらも executor から必要とするものがまったく同じ(この step 自身の証跡がどの directory にあるか)であり、step が片方に手を伸ばすときはもう片方にもほぼ同じくらいの頻度で手を伸ばすからです。
  パス区切りを含む、あるいは `.`/`..`/空文字列のいずれかと等しい `name` はそのまま拒否され、黙って書き換えられることはありません。
  step が自分では実際に頼んでいない名前を信頼してしまう方が、その名前を渡した呼び出しの場で大きな声のエラーが出るより悪い結果です。

待ちがどこに属するかは契約の問題であり、便利さの問題ではありません。
効果が非同期に別の場所へ現れるシステムに書き込む step は、その書き込みが受理された時点ではまだ終わっていません。
終わるのは、その効果が次の step が見ることになるものに対して見えるようになった時点であり、待ちはその step の内側に属します。
これは「契約はその step が何を要求するかを言う」という同じ規則を、後ろ向きではなく前向きに読んだものです。
代わりに待ちを後続の step に置くと、うまくいっているように見えます。
その step が待ち、scenario が通るからです。
けれどもその待ちは、それを必要としていた操作にではなく、経路の側に付いてしまいます。
同じ状態に、その step を経由しない経路で到達する別の scenario は、何も待たずに失敗します。
表に出てくるのは、その scenario だけが red になり兄弟の scenario は green のままという事態であり、これはその scenario 固有の性質のように読めますが、そうではありません。
green な scenario は、その待ちが正しく置かれている証拠にはなりません。
必要だった待ちはすべて、たまたまさらに下流で供給されていただけかもしれないからです。
それらを通らない経路だけが、待ちが本来どこに属するかを示せます。

`page` と `request` は、nukadoko 自身の型ではなく Playwright 自身の `Page` と `APIRequestContext` をそのまま返します。
これは代償を伴う選択であり、その代償ごと「Out of scope」に明記してあります。

`expect` は fixture ではありません。
step は `import { expect } from "playwright/test"` で直接インポートし、Playwright のテストとまったく同じやり方でアサーションします。
これは他のあらゆる fixture が従っているのと同じ規則から来ています。
fixture が運ぶのは executor が注入しなければならないものだけであり、`expect` は executor が所有するものを何一つ必要としません(アサーションの証跡はすでに trace(`actions`、「Receipt」を参照)を通じて receipt に届いています)。
fixture にしてしまうと、Playwright 自身がすでに公開している export の裏に何もない、ただのメンバーが増えるだけです。

`browser` も fixture ではありませんが、こちらは省略ではなく拒否です。
`context` は fixture です(`page` がすでに属しているものであり、新たに起動するものは何もありません)。
2 枚目のタブが要る step はこれを介して `context.newPage()` に手を伸ばします。
`browser` そのものを渡してしまうと、step は `browser.newContext()` を呼んで executor が一切見ていない context を作れてしまいます。
計測されず、trace も残らず、その run が書くどの receipt の外側にもなります。
この名前を bag から外しておくことが、そこへの経路を常に到達不能に保つ方法であり、step が忘れないよう気を付ける慣習ではありません。

2 つの形は、誤って部分的に解析されるのではなく、そのまま拒否されます。
デフォルト値を持つ分割代入された fixture(`{ page = ... }`)と、rest プロパティを通じて集められたもの(`{ ...rest }`)です。
どちらもこの節の冒頭で述べた静的な読み取りを台無しにします。
デフォルト値は `check` が本来きれいに読めるはずの名前を壊しますし、rest プロパティが実際に束縛する名前は、分割代入を実際に実行してみない限りわかりません。
そして `check` はそれをしてはいけません。
どちらも fixture が正当に必要とするものを何も失いません。
fixture は名指された時点で必ず存在するので、デフォルト値にはそもそもデフォルトを取る対象がなく、step が必要とする fixture はすべて必ず明示的に名指せます。
`check` と `nuka run`/`nuka do` はこの判定をひとつ共有します(「step の連鎖」ですでに `from` に使われているのと同じ「ひとつの判定を 2 つの呼び出し元が共有する」形です)。
そのため、step が `check` を通過したのに実行時にこの拒否で落ちる、あるいはその逆が起きることはありません。
未知の fixture 名、デフォルト値、rest プロパティのいずれも、実行が始まる前に実行そのものを拒否します。
未定義の step がすでに得ているのと同じ「開始しなかった」という結末であり、step の失敗では決してありません。

この読み取りは `check` の外にも露出しています。
`nuka steps --json` は、各 typed step 自身が分割代入した名前を `needs`(アルファベット順。何も要らない step では `[]`)として、そして `page` または `context` がそこに含まれるかどうかを `needs_browser` として報告します。
agent は scenario を選ぶとき、何ひとつ実行する前に、どれがブラウザを一切開かないかを見て取れます。
ブラウザを使う scenario は、API だけの scenario にはない分単位の時間と実物のターゲットを費やすからです。
`needs` は、この同じ静的な読み取りが解析できない唯一の `run()`(デフォルト値、rest プロパティ、分割代入パターンがあるべき場所にただの識別子がある場合)については、`[]` ではなく `null` になります。
そのエントリの `needs_error` が理由を運び、`needs_browser` もそれと一緒に存在しません。
このファイルが導けないブラウザ要否の判定を、あえて主張しないからです。
その step 自身の name/patterns/description はそれでも届きます: 1 つの読めない `run()` が、残りの一覧全体を道連れにすることはありません。
この呼び出し自身のトップレベルは、steps のベタな配列ではなく `{ steps, import_failures }` です。
`import_failures`(`{ file, message }`)は import に失敗したあらゆる step ファイルを名指しし、常に存在し、何も失敗しなければ `[]` です(下の「報告は寛容に、実行は速く失敗する」を参照)。

その中でただ 1 つ、移行前の形である `run(ctx, args)` の裸の、分割代入されていない第一引数については、同じ呼び出しが `needs_inferred` も報告します。
これはその step の fixture 要求についての字句上の推測であり、`run` 自身のソーステキストをその引数のメンバアクセス(`ctx.page`)について走査し、既知の fixture 名まで絞り込んで得られます。
これは独立したフィールドであり、`needs` に混ぜることは決してありません。
`needs` は分割代入パターンから読み取った、executor が step の実行前に実際に構築する対象であるのに対し、`needs_inferred` はまだ実行できない step についての推測であり、両者を一つにまとめてしまうと、この読み取りが裏付けられないものまで断定したことになります。
`needs_browser` はこれと一緒には推測されません。
上で `needs: null` がすでに得ているのと同じ不在です。
この走査は意図的に網羅的ではありません。
エイリアス(`const c = ctx; c.page()`)は一切追わないため、読み手はこれを完成した一覧ではなく、あくまで手掛かりの一覧として扱う必要があります。
これが現れるのは、throw が走査の手掛かりとなる識別子を運んでいたときだけです。
デフォルト値や rest プロパティによる throw は走査できる手掛かりを何も残さないため、`needs_inferred` はそれらでは単に省かれます。
これは、そもそもエラーが無く推測すべきものもない step でこのフィールドが省かれるのとまったく同じです。

ローカル変数が fixture と同じ名前を持つと、その fixture を覆います。
この間違いのうち、実行前に捕まる形はひとつだけです。
`run` 自身の関数直下でその名前を再宣言すると、分割代入されたパラメータそのものと衝突し、esbuild がファイルの transform を丸ごと拒否します(`The symbol "page" has already been declared`)。
代わりにネストしたブロック(`if`、ループ、コールバック)の中で再宣言すると、同じ衝突は何も言わずに読み込まれます。
`tsc` から見ればそれぞれの型で単独に整合するふつうのローカルな束縛でしかなく、指摘する材料がありません。
`check` も `run` の第一引数の分割代入パターンしか解析せず、その裏にある本体は決して読まないので、そこにも読むものがありません。
表に出るのは、実行が覆われた名前へたどり着いた瞬間だけで、しかもその瞬間に確実に落ちるとは限りません。
Playwright は `click`/`fill`/`hover`/`screenshot` のようなメソッド名を `Page` と `Locator` の間で意図的にミラーしているため、`Locator` に覆われた `page` は本物に対して呼ぶはずだったのと同じ呼び出しに答え続けてしまい、例外を投げる代わりに黙って別の要素を操作しかねません。
fixture を分割代入パターン自身のエイリアス構文で受け取れば、この衝突はそもそも起きません。
`run({ page: pwPage, section }, args)` なら、もう衝突する相手が残っていないので、ネストしたスコープの中で `page` を自由に何にでも束縛できます。
これは契約を何も変えません。
`fixtureParameterNames` はコロンの左側の名前を読むので、`{ page: pwPage, section }` も `{ page, section }` も同じ `["page", "section"]` として読まれ、`needs`、`needs_browser`、fixture の解決はすべてこの同じ一覧から導かれます。
nukadoko はこの覆いそのものを今のところ検出しません。
上の記述を、検出しているという主張として読まないでください。

### Fixtures

「Context API」が説明する bag は閉じています。
`page`、`context`、`request`、`env`、`requireEnv`、`baseURL`、`resultOf`、`section`、`poll`、`evidence`、それだけです。
プロジェクト自身の資源、テナント、シードされたデータベース、アップロードされたファイルを必要とする step には、その片付けを置く場所がこれまでありませんでした。
片付けを step 自身に書けば、feature ファイルが受け入れ条件ではない何かを名指すことになり、片付けを省けば漏れます。
`nukadoko.config.ts` はこの隙間を埋めます。

```ts
export default defineConfig({
  fixtures: {
    tenant: async ({ request }, use) => {
      const t = await createTenant(request);
      await use(t);
      await destroyTenant(request, t);
    },
    seededDb: [async ({}, use) => { await use(await seedDb()); }, { scope: "process" }],
  },
});
```

fixture は素の関数か、`[関数, options]` のタプルです。
Playwright 自身の fixture 定義が取るのと同じ 2 つの形であり、依存が `page`/`context`/`request`/`baseURL` の内側に収まる fixture なら、そのまま `base.extend()` に渡せます。
この共有できる部分集合は形についての事実であり、このパッケージが交わす約束ではありません。
`env`、`section`、`poll`、`resultOf`、`evidence`、あるいはほかの nukadoko 固有の名前を分割代入する fixture は、Playwright 自身の runner には何も意味しません。
そして `auto: true`(Playwright に、何も名指していない fixture を構築させるオプション)は、理由を名指したうえで丸ごと拒否されます。
feature ファイルが実行されたすべてを名指すという原則があり、何にも名指されていない fixture を構築することは、まさにその原則が禁じることだからです。
「同じ定義の形を受け取る」がこのパッケージの主張のすべてであり、その形を超えて「Playwright fixture 互換」を名乗ることはありません。
共有された 1 つの `fixtures.ts` を両方の runner の裏に置くのは、この機能の使い方として想定されていません。
TypeScript 自身の文脈型付けはインラインのオブジェクトリテラルにしか届かないので、fixture の集まりを素の `export const` に切り出すとそれが失われ、`strict` の下でコンパイルが通らなくなります。
`nukadoko` パッケージ自身が出す `defineFixtures` は、nukadoko 側のこの半分を直す手段です。
同じオブジェクトリテラルをそこに通すことで、TypeScript の見かけ上インラインのままにし、`request` と `use` の両方に、手で書く注釈なしで完全な型が付きます。
別のユーザー定義 fixture に依存する fixture は、その依存を `unknown` として型付けます。
その fixture 自身が宣言した型を与えるには、このパッケージが意図的に実装していない自己参照的な型推論が要るからです(実測では、ドキュメント化されていないコンパイラの挙動でしか動かず、頼るに値するものではありませんでした)。

fixture 自身の第一引数も、step の第一引数とまったく同じように分割代入されます。
「Context API」の冒頭で述べた静的な読み取りを、1 段階広げたものです。
`check` は fixture 自身の依存名をそのソーステキストから読み取り、決して呼び出しません。
step からの読み取りとまったく同じやり方です。
builtin(`page`、`context`、`request`、`env`、`requireEnv`、`baseURL`)を依存として名指すのは通常どおり動きます。
別の `config.fixtures` エントリを名指すのは、Playwright 自身の `extend()` と同じやり方で解決されます。
あとの層は前の層に依存でき、fixture は別の fixture に依存でき、その fixture はさらに builtin に依存できます。
builtin の上書きも同じやり方で許されます。
executor 自身の起動を包む `page` fixture(`page: async ({ page }, use) => { page.setDefaultTimeout(10_000); await use(page); }`)は、`page` をその下にある builtin として読み、自分自身としては読みません。
同名の依存が循環にならない唯一のケースです。
`page` も `context` も分割代入しない `page` の上書きは、executor が今も所有し計測しているページを返しようがないため、`check` がそれを拒否します(`page-override-unowned`)。

スコープは 2 つだけ存在します。
`scenario`(既定)は scenario ごとに、あるいは `nuka do` の実行ごとに再構築され、その scenario 自身の終わりに teardown されます。
`process` は 1 度だけ構築されます(`nuka run` のその実行全体を通じて、最初にどこかの step がそれを名指した時点、直接でも別の fixture 経由でも)。
そして、その実行のすべての scenario が終わったあとに、1 度だけ teardown されます。
`worker` は存在しません。
nukadoko にはまだ並列実行がなく、`worker` スコープはいまの `process` とまったく同じ意味を持つ 2 つ目の名前にしかならず、その区別が実際に存在するようになる前にその名前を使い切ってしまうことになるからです。
`nuka do` の下では、1 回の実行が両方の寿命のすべてなので、この 2 つのスコープは 1 つに畳まれます。
`process` スコープの fixture は、そこでは `scenario` スコープの fixture とまったく同じにふるまいます。
`process` スコープの fixture が依存してよいのは、ほかの `process` スコープの fixture と、`env`/`requireEnv`/`baseURL` だけです。
この 3 つの builtin だけは、どの scenario の context がそれを読むかによって値が変わりません。
`page`、`context`、`request`、`resultOf`、`section`、`poll`、`evidence`、あるいは `scenario` スコープの fixture への依存は拒否されます(`fixture-scope-violation`)。
`process` スコープの fixture は自分自身の構築を、それを供給したはずのその scenario より長く生き延びさせうるからです。

`process` は 1 つの `nuka run` 実行のことではなく、1 つのアドレス空間のことを名指します。
fixture 自身の値は素の JS オブジェクトであり、別のプロセスを越えて運べません。
だからこのスコープは、何回呼び出されようと「プロセスごとに 1 度」以外の意味を持ちようがありません。
今日は 1 回の `nuka run` 実行が 1 つのプロセスなので両者はたまたま一致していますが、その一致はこのスコープが約束しているものではありません。
世界の中で正確に 1 度だけ起きてほしい処理(データベースのシード、マイグレーションの実行、ポートを 1 つ占有するモックサーバの起動)は、それが何プロセス走ろうと起きてほしい処理であり、`process` スコープの fixture には置けません。
プロセスを複数走らせれば、また起きてしまいます。

teardown は構築の逆順で走ります。
その fixture を名指した step が通ったか落ちたかにかかわらずです。
fixture 自身の片付けコードは、それが仕えた step がすでに自分の理由で失敗したからといって省略してよいものではありません。
この逆順が正しいのは、nukadoko が fixture の構築と teardown を**直列に**行っているときだけです。
teardown を構築の正確な逆順で畳むと、あらゆる依存がその依存先より長生きすることが保証されますが、それはどの fixture の setup も teardown も同時に 2 つ走らせない限りにおいてです。
nukadoko が並列化される日、この前提は静かに崩れます。
ある fixture 自身の teardown が、別の並列な scenario がすでに片付けてしまった依存に手を伸ばすことは、まさに `check` が決して捕まえられない種類のレースです。
それは fixture グラフ自身の形についての事実ではなく、**いつ**についての事実だからです。
並列実行を足す人は、まずこの逆順に戻ってくる必要があります。

fixture 自身の成否、つまりそれを名指した step(`process` スコープなら run 自身)が通ったか落ちたかは、setup の時点ではまだ存在しません。
そのため fixture 関数の第二引数ではなく、`use()` の**戻り値**になります。

```ts
tenant: async ({ request }, use) => {
  const t = await createTenant(request);
  const outcome = await use(t);          // "passed" | "failed"
  if (outcome === "passed") await destroyTenant(request, t);
},
```

「失敗したテナントは調べるために残し、通ったテナントは壊す」は QA の標準的な運用です。
Playwright 自身の `afterEach` も同じ理由で `testInfo.status` を読みます。
teardown の失敗は step や scenario 自身の成否を決して変えません。
壊れた片付けのコードが、それ自身の受け入れ基準とは関係ない理由で、そうでなければ green だった run を red にしてはならないからです。
それでいて黙って消えることもありません。
`scenario` スコープの fixture の失敗は scenario record の `teardown_errors` に載り、`process` スコープの fixture の失敗(すべての scenario のあとに 1 度だけ teardown され、それを載せる 1 つの scenario record を持たない)は stderr に出ます。
`nuka run`/`nuka do` はどちらの場合も告知しますが、exit code は変わりません。

fixture は `use(value)` をちょうど 1 回呼ばなければなりません。
呼ばずに終えることは、その fixture 自身の関数が呼ばないまま決着した時点で検出され、fixture を名指したうえで throw されます。
2 回呼ぶことも同じように検出され、fixture を名指したうえで、2 回目の呼び出しが起きた瞬間に throw されます。
どちらも、fixture が存在する前には `ctx.page()` になかった穴を塞ぎます。
step 自身の本体が関数を呼ぶかどうかは、それまでその外側の呼び出し元が待つようなことではありませんでした。
fixture は違います。
fixture は nukadoko 自身が `use()` で中断させ、teardown で再開させるコルーチンであり、その中断点にまったく到達しない fixture は、そうでなければ run を永遠にハングさせてしまいます。
setup と teardown はそれぞれ自分自身のタイムアウト予算を持ちます。
`config.fixtureTimeout`(既定 60 秒)で、fixture 自身の `options.timeout` によって個別に上書きできます。
どちらの局面がタイムアウトしても、fixture と局面の両方を名指して報告されます。
名前のないハングより、名前の付いた失敗のほうが常にましだからです。

`check` は 3 つの fixture 固有の所見を報告します。
どれも fixture を一度も実行せずに決着します。
`fixture-cycle`(`config.fixtures` エントリのあいだの依存の循環)、`fixture-scope-violation`(`process` スコープの fixture が `scenario` スコープの fixture に依存している)、そして `page-override-unowned`(前述)です。
`tend` はさらに 2 つを足します。
どちらも verdict ではなく事実です。
`fixture-unused`(`config.fixtures` エントリのうち、どの typed step も直接にも別の fixture 経由でも要求していない、`nuka do` からはなお到達可能なもの)と、`fixture-touches-app`(`page`/`context` に、直接にも別の fixture 経由でも到達する fixture)です。
後者が存在するのは、fixture が feature ファイルの一度も名指していない前提のもとで scenario を green にしうるからです。
どの step も求めていないのにユーザーをログインさせておくのは、step 自身の Given が一度も書いていない作業を step がやってしまうのと同じ間違いを、1 段階離れたところでやっているにすぎません。
これは fixture がブラウザに触れることそのものへの規則ではありません。
`storageState` の生成は、fixture がそれを行う標準的で正当な理由であり、`tend` はそれを否定しません。
どの fixture がそうしているかを名指すだけで、それがそのリストにふさわしいかどうかは読み手が決めます。

実行自身の receipt は `fixtures` を運びます(空でないときだけ存在します)。
その実行自身の bag 解決が実際に触れた `config.fixtures` エントリすべてで、それぞれ `{ "name", "scope", "setup_ms"?, "at"?, "reused" }` です。
`setup_ms`/`at` は、その呼び出しが実際にそのインスタンスを構築したときだけ存在します。
`reused: true` のエントリでそれらが存在しないことこそが、「すでに構築済みだから速い」のか「0ms で計測された」のかを見分ける手段です。
この区別がなければ、`setup_ms` の不在は読み取れません。

`nuka steps --json` の `needs`/`needs_browser`(「Context API」を参照)は、実行と同じやり方で fixture グラフを閉じます。
`page` に到達する fixture だけを分割代入した step も、`needs_browser: true` と読めます。
その step 自身の `needs` 配列が名指すのは fixture の名前だけで、`page` を直接には一度も名指していなくてもです。
自分自身の `needs` が `null` として返ってきた唯一の step については、閉じる対象が何もありません(理由は「Context API」を参照)。
そのエントリには `needs_browser` もありません。
それでも `needs_inferred`(「Context API」を参照)は持つことがあります。
ただしこのフィールドは契約ではなく字句上の推測であり、`needs`/`needs_browser` のようには fixture グラフを閉じません。

### step の連鎖

CLI 専用の step(`pattern` を持たずに定義された step)に `pattern` を与えて scenario に束ねると、その step が単体では直面しなかった問いが立ち上がります。
以前の step が生成した値は、どうやってこの step まで届くのか、という問いです。
一見もっともらしい 2 つの答えは、どちらも何かを失います。
引数を捨てて `resultOf` だけで読むようにすると `nuka do` の単体実行を失います。
コマンドラインに渡すものが何も残らないからです。
そして単体で走ることこそが、その語彙を agent にとって有用にしている当のものなので、この損失は付随的なものではなく実質的なものです。
setup 全体を 1 つの複合 step にまとめれば既存の step には触れずに済みますが、Given の行が粗くなります。
その複合 step が実際に何をしているかは、その 1 文の裏に隠れて見えなくなります。

`from` は、キーがどこから来るかを一度だけ、データとして述べることで両方を成り立たせます。

```ts
import { defineStep } from "nukadoko";
import { z } from "zod";
import createProject from "./create-project.js";

export default defineStep({
  pattern: "the project is archived",
  description: "Archive the project created earlier in this scenario",
  args: z.object({ projectId: z.string() }),
  returns: z.object({ archived: z.boolean() }),
  from: { projectId: [createProject, "id"] },
  async run({ request }, args) {
    // args.projectId is present or this line was never reached.
    const res = await request.post(`/projects/${args.projectId}/archive`);
    return res.json();
  },
});
```

pattern の capture は今も優先されます。
`from` が補うのはこの step のこの出現がキャプチャしなかったキーだけなので、同じ step が、ある scenario では Gherkin の行から値を取り、別の scenario では以前の step から値を取ることができます。
そこで取られるのは、その以前の step がこの scenario 内で直近に成功した実行の結果です。
これは `resultOf` が持つのと同じ寿命です。
同じ chain だからです。
注入は args のバリデーションより前に起こります。
それこそが要点です。
キーは **required** のままであり、`args` は、呼び出し元の誰かがたまたまどう供給しているかではなく、その step が何を要求しているかを言い続けます。

1 つのキーは、複数の生産者の候補を列挙できます。
一部の値は 2 通りの経路で届きます(scenario 自身が作成したプロジェクトか、それが import したプロジェクトかです)。
そして、それを言うために消費者が 2 つの step に分かれる必要はありません。

```ts
from: { projectId: [[createProject, "id"], [importProject, "projectId"]] }
```

これが意図的に持ち込まないものが 1 つあります: 優先順位です。
最初に勝つという規則も、覚えておくべき宣言順も、異なる step をまたいで届く「直近優先」の規則もありません。
その代わりに以下のチェックは、列挙された生産者のうち **ちょうど 1 つ** が scenario 内でそれより前に束ねられていることを求めます。
0 個であれば、生産者が 1 つしかない場合にすでに起きているのと同じエラーになり、2 個以上であってもやはりエラーです。
答えが、その scenario の読み手自身には見えない規則に依存してしまうような scenario は、このツールが実行を拒否するものであり、それこそがこの機能を安全に追加できる理由です。
「これらのうちどれが値を供給するか」という問いには、step 側の既定値ではなく、feature ファイルが出現ごとに答えを与えます。

これは、*単一の* 生産者が繰り返された場合の決着の付き方とは異なる理由でもあります。
`Given a project is created` を 2 回書いてから消費者を書くと、それは直近のものとして読まれ、それは筋が通ります。
どちらの出現も同じ契約を運んでいるので、後の結果が前の結果を置き換え、問われているのは鮮度だけだからです。
*異なる* 2 つの生産者は、値がどちらの契約から来たのかを問います。
鮮度には正当化できる既定値がありますが、provenance にはありません。

生産者を候補として列挙することは、それらが互いに排他的である(どちらか一方だけが実行されており、両方ではない)と言っていることになります。
両方を本当に行使する scenario(同じレコードへの 2 つの経路を互いに突き合わせて確認する場合)はそもそもこの形をしておらず、1 つのキーとして書く必要もありません。
それぞれの生産者に、それぞれ専用のキーを与えてください。

```ts
from: {
  createdId:  [createProject, "id"],
  importedId: [importProject, "id"],
}
```

どちらも束ねられ、どちらも読まれ、何も競合しません。
ある値が *同じ scenario 内で* 2 つの生産者のどちらからでも届きうるのに、それを待つキーが 1 つしかないなら、間違っているのは消費者自身の形です。
scenario には 2 つあるのに、1 つのものを求めているからです。

なぜ selector 関数ではなくキー名なのか。
キー名はデータです。
`nuka steps --json` と `nuka describe` の中に「`projectId` ← `createProject.id`」として生き残り、それによって agent は一度も教わっていない順序を自分で組み立てられます。
`nuka check` が何かが実行される前に scenario を判断する際に読むのも、まさにこれです。
関数はより多くを表現しながらより少なくしか言えません。
ツールは、あるキーがどの step から来たかは報告できても、その step のどの部分から来たかは決して報告できないからです。
キーで参照できるくらい平らな形に `returns` を作ることは軽いコストであり、そのほうが step も結局は読みやすくなります。

`from` を宣言することは、確信を得るのに何も犠牲を払わないチェックを手に入れることです。
あらゆる scenario 内のその step のあらゆる出現について、`nuka check` は(そして `nuka run` も、その scenario を実行する前に)宣言された各キーがその行でキャプチャされているかを尋ね、されていなければ、上流の step が同じ pickle 内でそれより前に現れているか(Background を含みます。pickle は自分の Background の step を運ぶからです)を尋ねます。
`nuka run` がこれを行うのは、check し忘れることがブラウザセッション 1 回分の代償で罰せられないようにするためです。
宣言された生産者が 1 つも束ねられていない **required** なキーはエラーです。
その run は確実に args のバリデーションに落ちるので、早い段階でそう言っても偽陽性を生みません。
宣言された生産者が 1 つも束ねられていない **optional** なキーは何も言いません。
スキーマがすでに値は無くてもよいと言っており、守られている契約について警告することは、ノイズが致命的な唯一の場所でノイズを出すだけだからです。
あるキーに列挙された生産者のうち 2 つ以上がそれより前に束ねられている場合は、そのキーが required か optional かによらずエラーです。
スキーマは「この値は無くてもよい」と言うことはできますが、「このどちらか一方、ただし feature ファイルはどちらかを教えてくれない」を求めるスキーマは存在しないからです。
これは `from` を動機づけたケースを閉じます。
消費者を生産者より前に束ねる scenario は、実際のブラウザ時間で数分が費やされるまで、正しい scenario と見分けがつきませんでした。

`from` と `resultOf` はどちらも、上流の step を名前ではなく `Step` オブジェクトそのもので識別します。
そのため `await import()` を経由して届いた step は discovery が登録したものとは別のインスタンスに解決され、何にもマッチしません。
これはかつては無音でした。
`resultOf` はただずっと `undefined` を返し続けるだけでした。
今はもう無音ではありません。
登録されていない `Step` は、それが見つかった場所でエラーになります。
`from` は静的にそれを名指しするので `nuka check` がそれを報告し、`run`/`do` はその step の実行そのものを拒否します。
一方 `resultOf` は呼び出しの時点でしか捕まえられず、そこで投げます。
登録済みだがまだ実行されていない step は今も `undefined` を返します。
それは間違いではなく状態です。

`from` が表現できないものは `resultOf` に残ります。
途中で形を変える必要がある値、必要かどうかが実行時にしか決まらない読み取り、あるいは result 全体をまるごと使う場合です。
そうした場合は `resultOf` に手を伸ばし、その step が単体でも走らなければならないなら、引数を optional にして `run` の中でフォールバックするという、以前からの形を使います。
この形はもう既定のやり方ではなく、例外です。

`nuka do` の下には scenario がなく、したがって chain もありません。
そのため `from` のキーは、他の引数と同じように `--args` で渡されるか、`--use` を使って以前の実行の receipt から取られるか(「単体 step」を参照)、2 つの経路のどちらかで届きます。
どちらの経路でも step の契約は変わらず、値がどこから来るかだけが変わります。

`from` が意図的にやらないことが 1 つあります。
上流の step をあなたの代わりに実行することです。
生産者が scenario から欠けているキーは feature ファイル側で直す誤りであって、ツールが黙って挿し込む step ではありません。
実行されたすべてを名指ししない feature は、このツール全体が存在する理由である記録であることをやめてしまうからです。
これに関連する圧力は現実のもので、別の答えを持っています。
連鎖する値は必ずどこかの step から来なければならず、その step は feature の中に現れなければならないため、scenario には id を運ぶためだけに存在し(`And the project's billing page is fetched`)、その feature が書かれた対象の読み手には何も意味しない行が残ることがあります。
ある操作がその読み手にとって価値を持たないなら、それはそもそも step であるべきではありません。
`features/steps/lib/` の下に普通の関数として置き、それを必要とする step から呼び出します。
そこで手放すのはそのヘルパー自身の receipt であり、それが行う HTTP は今も `observed` に数えられ、`section` も実行がどこまで進んだかを記録し続けられます。
記録の粒度と feature の読みやすさは、step の書き手が場合ごとに下す判断であり、これがその判断を下す軸です。

step の連鎖は宣言と計測が出会う場所であり、`mutates` の場合(「キーワードの意味論」を参照)とは違う出会い方をします。
そちらでは、計測はプロキシです。
HTTP メソッドが書き込みの意味論の代わりを務めており、そのためツールは両方を記録しながらどちらも突き合わせません。
ここにはプロキシがありません。
どの receipt から値が来たかは正確に分かっています。
そして `from` はそれを記述するのではなく実行そのものを駆動するため、宣言と実際に起きたことは食い違いようがなく、そもそも突き合わせるべきものが最初から存在しません。
receipt の `used`(「Receipt」を参照)は、それゆえ宣言に対するチェックではなく、宣言には答えられない問いに答えます。
値を供給したのがどの step かはファイルが書かれた時点ですでに決まっていましたが、それを供給したのがどの実行かは実行時にしか決まらず、`used` が答えるのはその問いです。

### キーワードの意味論

Gherkin のキーワードが本当の事実を運ぶのは、`mutates` が**nukadoko が信頼する宣言**だからです。
ツールが実行結果から事実を導き直し、食い違えば宣言を上書きするから、ではありません。
実際の corpus がこの先の分割を強いたのは、同じ文が Action の位置と Outcome の位置の両方に正当に現れ、慣用的なスイートが `And` を使って `Then` の後に操作を連ね、任意のコマンドをラップする step には単一の正直な `mutates` の値がないからです。
step ごとの boolean は出現ごとの事実を運べないため、宣言が何を解決するかは層になっています:

- `mutates` は step の**宣言された意図**です(デフォルトは `true`。読み取り専用の step は `false` を宣言します)。
- **静的には**、宣言上 mutate する step が Then の位置に結び付けられていると、`nuka check` はエラーではなく警告を出します。
  この緊張関係は人の目でのレビューに値します。
  宣言だけではそれを解決できず、このチェックはあくまで警告にとどまります。
- **読み取り専用の environment は、宣言上 mutate する step を実行前に拒否します。**
  宣言がレビューの目を引くのではなく、実行そのものをゲートする唯一の場所です。
- **実行時には**、receipt がその実行が実際に行ったことを記録します。
  ツールが見たすべてのネットワーク呼び出しが対象であり(`request` fixture と page の両方を通じたもの)、GET/HEAD 以外の呼び出しはすべて観測された書き込みとして数えられ、`mutates`(宣言)の隣に置かれます。
  この回数はもはやそれ単独では何も決めません。
  Then の位置も、読み取り専用の environment 自身のポリシーもです。
  宣言された `mutates: false` は、`observed` が何を示していようと信頼されます。
- gherkin は `And`/`But` の step を、直前の主要なキーワード(Given/When/Then)の pickle step type を継承することで分類します。
  これは nukadoko の選択ではなく、gherkin 自身の pickle コンパイルの挙動です。
  そのため `Then` の後に連なる操作も、そこにある他のどの step とも同じように Then の位置の観測のもとで記録されますが、それによってゲートされることはありません。
- なぜ計測がこれを決めるのをやめたのか。
  書き込みの検出は HTTP メソッドに基づいており(GET/HEAD 以外はすべて書き込みとして数えます)、これは書き込みの意味論そのものではなく、そのためのプロキシです。
  GraphQL、RPC-over-POST、そして多くのベンダーの query API は、意味的に純粋な読み取りを POST の上に実装します。
  ある呼び出しが実際にサーバーの状態を変えたかどうかは外部システム自身の意味論であり、nukadoko はその 1 つ下の層、HTTP のレイヤーにいます。
  読み取りと書き込みを区別する手掛かりは、毎回プロトコル固有です。
  GraphQL の body の `query` と `mutation` の違い、RPC の body のメソッド名、ベンダー独自の path の規約などです。
  だからこのプロキシに代わる、汎用の機械的な判定は原理的にありません。
  この回数が保証するのは step が何を送ったかであって、サーバーの状態が変わったかどうかではありません。
  この 2 つは別の事実であり、前者を後者の証拠として扱うことは言い過ぎでした。
- 記録が縮んだわけではありません。
  `observed`、http.jsonl、そして Allure の declared/observed テーブルは、計測されたとおりにそのまま残ります。
  そのため誤りだった宣言も、そこには見え続けます。
  事後に反証可能なままだということです。
  反証可能な宣言を受け入れることは計測の放棄ではなく、この特定の事実についてツールの権限が実際に及ぶ範囲の終わりです。
- 反証可能であることと、実際に照合されることは別です。
  `mutates` と `observed` はすでに同じ receipt の上にあり、運用者は別の artifact なしにそれらを見比べられますが、nukadoko 自身がその照合を行うことは決してありません。
  `nuka run` も `nuka check` も、両者の食い違いを主張する出力を一切持ちません。
  その主張を自動化することは、同じ HTTP メソッドというプロキシを確定した事実として信頼することを意味します。
  GraphQL の呼び出し、RPC-over-POST の呼び出し、POST の上で読み取るベンダー API は、そのたびに偽陽性として読まれてしまいます。
  これは上記で実行時の強制をやめたのと同じ理由であり、ここでは実行ではなくレポーティングに適用されています。
  `nuka accept` 自身の record だけがこの照合を書き出す唯一の場所です(Sign-off を参照)。
  sign-off は人間がすでに run を読み判断している唯一の瞬間なので、そこで生の事実を述べても、`nuka run`/`nuka check` の毎回の呼び出しで述べる場合のような偽陽性ノイズのコストはかかりません。
- Compat(型のない)step には、そもそも宣言すべき `mutates` がありません(「compat step に欠けているもの」を参照)。
  `nuka check` の `then-compat-step` 警告は、Then の位置に結び付けられた compat step を、mutation の緊張ではなくこのカバレッジの欠落として指摘します。
  実行時の観測はどの step とも同じようにその回数を記録しますが、何もゲートしません。

## Compat steps(移行の扉)

既存の Cucumber + Playwright のテストスイートにとっての導入経路は、import を 1 つ差し替えることです:

```ts
// before: import { Given, When, Then } from "@cucumber/cucumber";
import { Given, When, Then } from "nukadoko/compat";
```

- Compat の step はそのまま動きます。
  パターン構文は同じで、`page` / `request` を持つ World(`this`)は nukadoko の harness によって提供され、管理されます。
  カスタムの World クラスは `setWorldConstructor` を通じて nukadoko の基底クラスを拡張します。
  サポートされる API はよく使われるサブセット(Given/When/Then、World、Before/After、AfterStep)で、必要に応じて拡張され、先回りしては拡張されません。
- 登録の意味論: `Given` / `When` / `Then` は 1 つの登録の 3 つの名前です。
  キーワードは登録時には何も意味せず、実行時に scenario 内の位置が決めます(Cucumber とまったく同じです)。
  pattern は文字列(素の cucumber-expressions。named capture はここでは要求されません(その規律は typed step のものです))または RegExp です。
  レガシーな glue は regex が多く、扉はそれを受け入れなければならないからです。
  cucumber-js の両方の呼び出し形、`Given(pattern, fn)` と `Given(pattern, { timeout }, fn)` にそのまま対応し、`timeout` は尊重されます。
  認識できないオプションキーは、消えてなくなるのではなく登録時に例外を投げます。
  discovery はファイルを import し、各登録をそれを行ったファイルに帰属させます。
  compat step の同一性はその pattern テキストで、`nuka steps` は kind 付きで列挙し、`nuka describe` は「持っていない契約」を明示し、`nuka do` は名指し実行を拒否します。
  単体実行が欲しくなったら、それが `defineStep` への昇格で手に入るものです。
- compat コードからの `defineParameterType` は、`config.parameterTypes` と同一の単一レジストリに登録されます。
  登録を config へ移してもどの pattern のマッチも変わらないことが、この移動を早く安全に行えるものにしています。
  `nuka check` は support 由来の登録を警告として列挙します。
  config が、それらの引退先です。
- 実行は、扉の約束を 2 つの方法で守ります。
  自前で Playwright を起動する glue は計測されないまま動き続けます。
  一方で `await this.openPage()` / `await this.openRequest()` は harness の計測される page と request を渡します(混在 scenario の typed step と同じ context を共有し、cookie も共通です)。
  table は依存ゼロの薄い `DataTable`(raw / rows / hashes / rowsHash / transpose)として届きます。
  `table.hashes()` を呼ぶ glue が import の差し替えで壊れてはならないからです。
  docstring は素の string のままです。
  Before / After フックは、cucumber-js が受け付ける 3 つの書き方(`Before(fn)`、`Before({ tags }, fn)`、`Before("@tag", fn)`)のどれでも書け、cucumber 自身のフック引数を受け取ります。
  タグ絞り込みは `@tag` と `not @tag` のみで、それ以上の式は黙って誤マッチする代わりに大きな声で失敗します。
  フックは receipt ではなく scenario record の `hooks` 配列に現れ、フック中のネットワークはどの step の境界にも属しません。
  http.jsonl と observed の読み書きカウントは scenario 全体で共有され続け、個々の hook 呼び出しに紐付けられることはありません。
  ただし Playwright の trace は違います。
  `this.openPage()` に触れた Before/After/AfterStep の個々の呼び出しは、それぞれ自分自身の trace chunk と `actions` のリストを持ち、同じ `hooks` 配列のエントリ上に記録されます(`trace`/`actions`/`truncated` は step 自身の receipt と同じ形です。「Receipt」を参照してください)。
  これは各 step 自身の chunk からも、他の hook からも独立しています。
  hook の呼び出しには、依然として `sections`/`polls` はありません。
  `section`/`poll` を呼ぶための fixture bag を hook が持たないからです。
  hook 自身が明示的に呼んだものではなく trace chunk 自体から読み出される `actions` だけは、この制約の影響を受けません。
  `AfterStep` はこれと同じ登録面(3 通りの呼び出し形、同じ `@tag` / `not @tag` のフィルタ)を共有しますが、Before/After が scenario 全体を挟み込むのに対し、`AfterStep` は実際に実行された pickle step ごとに 1 回走ります。
  この scenario がそれより前の step の失敗によってスキップした step は始まってすらいないため、`AfterStep` にとっての「後」はそこには存在せず、その step については何も現れません。
  これはタグが一致しなかった hook がすでに従っている慣習と同じです。
  `hooks` 配列内の各 `AfterStep` エントリは `step_index` を運びます。
  これは、その record 自身の `steps` 配列の中での実行された step の 0 始まりの index であり、レポートがエントリ同士を区別できるようにするためのものです。
  Allure と cucumber-messages の両方の emitter がこれをそのまま運びます。
  フック引数の `result.status` は `@cucumber/messages` 自身の `TestStepResultStatus` の文字列値をそのまま使っているため、`nukadoko/compat` は同じ enum を `Status` として re-export しており、`result.status === Status.FAILED` と書かれた glue はこれで正しく import され比較できるようになります。
  この enum の他のメンバー(`PENDING`/`SKIPPED`/`UNDEFINED`/`AMBIGUOUS`)は決して一致しません。
  nukadoko には、hook 自身の result が運びうる pending、skipped、undefined-step、ambiguous-match のいずれの概念もないからです。
  それらのどれかとの比較は、移行した glue が決して通らない分岐であり、残された gap ではありません。
  `BeforeAll`/`AfterAll` は scenario ではなく run 全体を挟み込み(tags は取らず、World もなく、scenario が 1 つも選ばれなければ丸ごとスキップされます)、record は scenario の形をしたものであり、これらの hook はどの scenario にも属さないため、報告は exit code を通じて行われます。
  `setDefaultTimeout` は、自分の timeout を宣言していないものすべてに既定値を与えます。
  呼ばずにおけば、step は cucumber の 5 秒という上限を持ち込む代わりに無制限のままになります。
  移行しただけの理由で、遅いスイートを失敗させてしまわないためです。
- World は常に計測されます。
  すべての compat step の receipt は、その step が World のどのキーを読み書きしたかをアクセス順で記録します(`this.foo` が隠していたデータフローです)。
  計測面はバッグの own データプロパティです。
  `#private` の状態は構造上そこに現れません(バグではなく、名前の付いた境界です)。
  `defineWorld({ key: zodSchema })` はキー単位で検証を有効にし(スキーマに失敗した書き込みは step の失敗であり、write としては記録されません)、`class MyWorld extends defineWorld({...})` で `this` に型が付きます。
  cucumber 自身の `attach` / `log` / `link` / `parameters` は予約キーです。
  計測されず、宣言もできず、上書きは黙った破壊の代わりにエラーになります。
- harness がブラウザと request のオブジェクトを所有しているため、compat の step もコードを一切変更せずに、計測済みの receipt(status、timing、trace、screenshots、HTTP log)をすでに得られます。
- compat の step に欠けているのは、型付きの契約、receipt 内でバリデーションされた `result`、そして単体 step の CLI 実行です。
  よく使う step を `defineStep` に昇格させることが、1 step ずつ進めるアップグレードです。
- 扉の幅は、主張ではなく計測されています。
  公開されている cucumber-js のスイート 8 本を、この扉に対して監査しました(glue はテキストとして読んだだけで、実行はしていません)。
  当時はどのスイートも import の差し替えだけでは通りませんでしたが、そこで見つかった障害をふさいだことで、8 本のうち 2 本はその後、glue の中に拒まれるものが何もない状態になりました。
  残りが何を必要とするかは [docs/migration.ja.md](migration.ja.md) に列挙されています。
  そこから導かれ、監査の発見が注ぎ込まれた規則はこうです: compat が対応しないものは、静かにではなく、import の時点か最初の実行で必ず失敗しなければなりません。
  移行するチームは、大きな声の失敗には対処できますが、静かな失敗は見えません。
  だから、黙って振る舞いを変えてしまう抜けは、機能が欠けていることが食ってきた時間よりも多くの信頼を食います。
- 大きな声の失敗は、静的な検査ですでに言えることと、step を実際に実行して初めて分かることに分かれ、`nuka check` が報告するのはちょうど前半です。
  **`nuka check` が言えること**: import が例外を投げる step ファイル(`nukadoko/compat` が export していない名前を値として使っている、ESM glue の中の CommonJS `require`、深い subpath の import)は `step-file-import-failed` エラーになり、単一の `@tag` / `not @tag` を超える hook のタグ式は `unsupported-hook-tag-expression` エラーになります。
  どちらも、何かが実行される前に、そのファイルのテキストだけから分かります。
  その隣にはさらに 2 つの所見があり、どちらも 1 つのファイルの中身についてではなく discovery 自身が歩く範囲についてのものです。
  `.cjs` ファイルが `featuresDir` の下にあるときの `step-file-unsupported-extension`(nukadoko がそれを import しない理由は前述の「型付き step」を参照)と、歩いた結果として試せるものが何もなかったときの `no-step-files-found` です。
  どちらも、実際に何を見た結果なのかを名指しします。
  これは、`nuka tend` 自身の `scanned:` 行が従っているのと同じ「所見が嘘のとき、それに気づけるように」という論拠です。
  **`nuka run` で初めて見つかること**: step や hook が `"pending"` / `"skipped"` を返すこと、そして done コールバックの glue は、その step が実際に実行されたときに何をするかの性質であり、ファイルの import のされ方の性質ではないため、その step 自身の実行より前には何も指摘できません。
  **どちらでもない(gap ではない)こと**: 型注釈にしか使われていない、あるいは import はされたが一度も参照されない名前は、nukadoko がそのファイルを import するより前に esbuild によってコンパイル済み出力から取り除かれるため、その import は実行時には実際には一度も起きません。
  glue は書かれたとおりに実行されます。
  `tsc` はその名前を compat が export しているものに対して解決するので、欠けている名前はコンパイルエラーであって実行時のエラーではありません。
  監査がこの分類で見つけた 2 つの名前、`IWorldOptions` と `ITestCaseHookParameter` を export する価値があったのはまさにそのためです。
  `nuka` がそれらの失敗を一度も見なかったとしても、その代償は利用者の実行ではなく利用者の型検査が払っていました。
- この節と、移行に触れる今後のすべての設計に適用される恒久的な設計規則: 今日動いている compat の資産は、チームが nukadoko を採用したことや、他のどこかを typed 側へ動かしたことを理由に、動かなくなってはなりません。
  移行途中の「住まいが 2 つある」状態(support コードに登録された parameter type と config に住む parameter type、World のバッグと typed の result の併存)は、禁止するのではなく受け入れます。
  ただしそれらは必ず 1 つの実体を共有し、分散は隠さず `nuka check` が可視化し、個々の移行の一手は意味を変えないものに限ります(だから早く安全に動かせます)。
  扉は両方向に開きます: import を元に戻せることは維持されます。
- 既存の cucumber-js + Playwright スイート向けに、この扉の手順を追った解説が [docs/migration.ja.md](migration.ja.md) にあります。
  すでに nukadoko の上にあるプロジェクトを新しいリリースへ移すのは別の問いであり、[docs/upgrading.ja.md](upgrading.ja.md) で答えます。

## 実行

### Scenario(スクリプト化された経路)

```sh
nuka run features/checkout.feature[:12] [--env <name>] [--session <name>] [--quiet]
```

`@cucumber/gherkin` はファイルを pickle にコンパイルします(Background がマージされ、Scenario Outline が展開され、table が結び付いた、フラットで自己完結な scenario)。
nukadoko は各 pickle の step をコミットされた pattern と照合し、step を順番に実行します。
step ごとに 1 つの receipt。
pickle ごとに 1 つの scenario record(feature のパス、scenario 名、順序付けられた receipt id、step ごとの status)。

各 run は読み手の違う 2 つのチャネルに書き込みます。
stdout は NDJSON 専用のままで、1 行に scenario record が 1 つ載るだけであり、スクリプトが読むためのものであって、それ以外は一切書き込まれません。
run を見ている人間向けのものはすべて代わりに stderr に載ります。
各 pickle が始まる直前の境界の行、step が終わるごとの 1 行、run が終わった時点でこの run が実際に書き込んだ場所、そして 1 行のサマリです。
`--quiet` は step ごとと scenario ごとの、この 2 種類の進捗行だけを止めます。
書き込み先の行とサマリはどちらにしても出ます。
出力先を告げることは、より静かな端末を目的としたフラグのために抑制する価値があるものでは決してないからです。

書き込み先の行は、何も設定していないときにこそ効きます。
`allure` と `messages` の出力はすでにゼロ設定で動いており、それぞれの config キーは書き込み先を移動させるだけです。
config ファイルに載っているキーは、設定して初めて有効になるものだと読まれがちです。
その誤読を、実際に書き込んだ場所を毎回すべて出力することが取り除きます。
この行のおかげで、プロジェクトは最初から出力を持っていたことに気付かないまま出力先だけを動かしてしまう、ということがなくなります。

scenario record 自身の `browser` フィールド(`{ "type": "firefox", "version": "133.0" }`)には、この run が実際に起動したエンジンとバージョンが入ります。
これは Playwright が返す実際の `Browser` オブジェクトから読んだ値であり、`config.browserType` から読んだ値ではありません。
両者は食い違うことがあります(step が `page` fixture をこの run 自身の `ctx` が一度も起動していない別のブラウザで上書きすることがあるからです)。
記録に足るだけの信頼性があるのは計測された側だけです。
run の pickle が一度もブラウザを起動しなかった場合、このフィールドは何らかの既定値になるのではなく、存在しません。
`page`/`context` を分割代入しない step だけの pickle は何も起動せず、このフィールドが一度も走っていないブラウザを名指すことはありません。

`:12` は 1 つの scenario だけを選び、これが反復のための経路です。
feature のフル実行はすべての scenario の分数を消費し、その中の 1 つを正しくすることが、たいてい次の数回の実行の目的です。
これは同じものの縮小版ではありません: 部分実行は決して sign-off できず(「Sign-off」を参照)、green になったところでそれはデバッグの結果でしかないからです。
`nuka run` は行番号が与えられたその場でそれを告げます。
すでにその道を何度も進んでしまったあとになって `nuka accept` に気付かせるのではありません。

1 つの pickle 内の step は 1 つの context を共有します(Cucumber ユーザーが期待する World の意味論です)。
ログインする Background は、以降のすべての step にブラウザと cookie を引き継ぎます。
失敗した step は scenario の残りをスキップし、スキップされた step には receipt が作られません(始まってすらいない実行が引用可能であってはならず、「skipped」と言うのは scenario record の役目です)。
Evidence は自然なスコープに従います。
各 step の receipt は、その step 自身の http.jsonl と、その step 自身の Playwright trace の両方を持ちます。
trace はかつて、共有された context 全体にまたがる 1 本のファイルとして scenario 自身のディレクトリに置かれ、`page` を bag に名指した最初の step で一度だけ開かれ、最後に一度だけ閉じられていました。
今は step の境界ごとに切られ、ブラウザに一度も触れない step にはそもそも trace の chunk が無く、触れた step にはその step 自身の操作だけが入った chunk があります(これは step 自身の fixture bag がすでに持っていた「必要な名前だけ構築する」という性質と同じ切り方です)。
落ちた step の trace を直接開けるほうが、何が起きたかを scenario 全体の録画からスクラブして探すより速く、それがこの変更の理由のすべてです。
シナリオ全体の 1 本の trace がついでに与えていたもの、つまり全 step をまたいだネットワークの通し view は、step ごとの trace には無くなります。
各 step 自身の trace にはその step 自身の通信は変わらず入っているので、1 つの step 単体の通信について失われるものは無く、失われるのは scenario 全体の通信を 1 つのファイルだけ開いて眺められるという点だけです。
`request` fixture の通信と page 自身の通信は、いまや同じ step ごとの view を共有します。
どちらも同じ http.jsonl に載り、各エントリには `via: "request"` か `via: "page"` の印が付くため、読み手はどちらの経路が通ったかを推測せずに済みます。
http.jsonl に載る page 由来のリクエストは `document`/XHR/`fetch` の 3 種類だけです(1 回のページ読み込みは画像やスタイルシート、スクリプトの束を何十件も引き込みうるため、それを全部保持しようとするファイルは読み手が開けるものではなくなってしまいます)。
ただし落とされたことが黙って消えるわけではありません。
落とされた分は receipt 自身に、リソースタイプ別に `http_omitted` として載ります(「Receipt」を参照)。
`observed` はこれによって一切狭められません。
image や script の通信も含め、ツールが見たリクエストをすべて数え続けます。
それは http.jsonl とは違う問いに答えているからであり、2 つの数は一致することを期待されていません。

pickle が実行される前に、その step たちの `from` 宣言は自分自身の step の順序と照合されます。
required な連鎖キーの生産者が欠けているか、より後ろで束ねられている場合、その scenario は何かが起動するより前に失敗します。
実行しても、数分後に同じ失敗に終わるだけだからです(「step の連鎖」を参照)。
ファイル内の他の scenario はそのまま実行されます。
これは 1 つの scenario の性質であって、ファイル全体の性質ではないからです。

undefined な step は、マッチに失敗したテキストを名指しして scenario を失敗させ、`nuka scaffold` を提案します。
同梱の skill に従う agent が、欠けている型付き step を作成して PR として提出します。
feature のバックログが語彙の成長を駆動します。

### 単体 step(agent の経路)

```sh
nuka do create-project --args '{"name":"acme"}' [--env <name>] [--session <name>]
nuka do archive-project --use rcpt-20260801-143022-a1b2
```

1 つの型付き step を実行し、その receipt を stdout に出力します(ok なら exit 0、failed なら 1)。
これが適応的なループです。
agent はバリデーション済みの result を読み、次の呼び出しを決めます。
agent が選べるのはどの step をどの args で呼ぶかだけで、何が記録されるかを選ぶことはできません。
`do` には意図的にグループ化のラベルがありません。
ad-hoc な一連の呼び出しは作業記録であり、evidence ではありません。
証明する価値のあるものはすべて scenario として表現され、`nuka run` によって証明されます(Self-healing を参照)。

`--use <receipt-id>`(繰り返し指定可)は、scenario なら chain が渡していたはずの値の代わりに、以前の実行から step の `from` キーを供給します(「step の連鎖」を参照)。
上流の step の名前がコマンドラインに書かれないのは、receipt がすでにそれを運んでいるからです。
nukadoko はその receipt がどの step を記録したものかを読み、そこを指す `from` のエントリを見つけ、名指しされたキーをその receipt に保存された `result` から取り出します。
この step が `from` を宣言していない step の receipt は、黙った no-op ではなくエラーになります。
実行が失敗した receipt も同様にエラーになります。
失敗した step は読み取れるバリデーション済みの結果を一度も生み出していないからです。
同じキーについては scenario の中で pattern の capture が勝つのとまったく同じように、`--args` は今も `--use` に勝ちます。
実際に取り出された receipt id はこの実行自身の `used` に載るので、複数回の `do` 呼び出しにまたがって手で組み立てた chain も、scenario が駆動した chain と同じくらい後から追跡できます。

`do` の下で通った step は、それだけでは `run` の下でも通ることが示されたわけではありません。
`do` はすべての実行にそれぞれ専用のブラウザとそれ以外のすべてを与えますが、scenario はそのすべての step に 1 つの context を与えるので、2 番目の step は 1 番目が残したものをそのまま引き継ぎます(すでにログイン済みかもしれず、別のページにいるかもしれず、ダイアログが開いたままかもしれません)。
この 2 つの問いは別物であり、どちらの答えも他方の代わりにはなりません: `do` はその step が動くかどうかを問い、`run` はそこで動くかどうかを問います。
`--session` は storageState を `do` の呼び出しをまたいで持ち運ぶことでこの差を狭めますが、それがカバーするのはログイン状態だけであり、それ以外の何ものでもありません: 実行がどこまで進んでいたかはそこには含まれません。
これがいちばん厳しく効くのは、自分自身の setup が 2 回目の実行では no-op になってしまう step で、直すべきは engine ではなく feature の側です: 状態は step ごとに毎回立てるのではなく、それを行うと名前が言っている step の中で一度だけ立てます。

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
  "mutates": true,
  "observed": { "http_reads": 2, "http_writes": 1 },
  "environment": "dev",
  "target_version": "1.4.2+abc123",
  "session": "checkout-flow",
  "scenario": null,
  "started_at": "...",
  "finished_at": "...",
  "evidence": {
    "dir": ".nukadoko/receipts/rcpt-20260801-143022-a1b2",
    "trace": "trace.zip",
    "screenshots": [{ "file": "final.png", "at": "..." }],
    "http": "http.jsonl"
  }
}
```

- `result` は信頼の錨です。
  returns のスキーマを通過しており、それを作ったのは(呼び出し側ではなく)ツールです。
  失敗時には `error: { kind, message }` がそれに置き換わります。
  compat の step は `result: null` を記録します。
- `error.kind` は閉じた集合で、人間が読むメッセージのほかに `args_invalid`、`result_invalid`、`binding_invalid`、`world_invalid`、`timeout`、`unsupported`、`step_error` の値を取ります。
  閉じているのは、レポートがこれに対して分類を行うからです(step ごとに拡張される開いた集合では、何も分類できません)。
  最初の 4 つは、契約があるからこそ存在する失敗を指し、return 値を捨てる runner の上に作られたレポートでは埋められない部分です。
  確信が持てない分類器が `step_error` を返すのは、契約違反を誤って主張するほうが、主張しないより悪いからです。
  scenario record の中の hook record も同じフィールドを持ちます。
- `mutates` は step 自身の宣言であり(compat の step には記録すべき宣言がないため `null` になり、`false` にはなりません)、`observed` のカウントと並んで置かれることで、宣言された値と計測された値を別の artifact なしに比較できます。
- Evidence は harness によって収集され、step が自己申告することは決してありません。
  ブラウザが使われるときは Playwright の trace とスクリーンショット、`request` fixture の呼び出しと page 自身の document/XHR/fetch の通信はすべて http.jsonl に記録され、receipt 自体が一次記録になります。
- `evidence.screenshots` はエントリ 1 つまでで、`{ "file": "final.png", "at": "..." }` という形を取ります。
  ブラウザを使う実行の evidence は以前は 2 つのファイルで、step が失敗するたびに同じバッファを別名でもう 1 つ保存していました。
  それを書くこと自体にコストは無かったものの、ツールが一度も計測していないことを暗に主張していました。
  「失敗」スクリーンショットが、最後に撮られたものとは別個の事実として存在するという主張です。
  実際にはそうではありませんでした。
  スクリーンショットは `run` がすでに返るか投げたあとに一度しか撮られないため、その 2 つ目のコピーは、それが名指す失敗に対してすでに古びている可能性がありました。
  `at`(ISO 8601。`started_at`/`finished_at` と同じ形式)は、その 2 つ目のファイルが一度も明言せずに肩代わりしていたものを、実物として言い当てます。
  この実行自身のタイムラインから何秒後にそのスクリーンショットが実際に撮られたか、です。
- `observed` は、その実行に対してツール自身が見たネットワーク呼び出しを数えます(`request` fixture と page の両方を通じたもの)。
  GET/HEAD 以外はすべて書き込みとして数えられます。
  これは書き込みの意味論そのものではなく、HTTP メソッドをそのプロキシとして使っているため、一度も書き込んでいない step に POST ベースの読み取りが不利に働くことがあります(キーワードの意味論を参照してください)。
  この回数はそれ単独では何も決めません。
  Then の位置も読み取り専用の environment も、作用する対象は `mutates` の宣言であり、この回数では決してありません。
  `observed` は `mutates`(宣言)の隣に置かれているため、誤った宣言はここでも Allure のレポートでも反証可能です。
- `evidence.http`(少なくとも 1 回の呼び出しが記録されたときだけ現れます)は http.jsonl を指します。
  1 行に 1 つの JSON オブジェクトで、形は `{ "method", "url", "status", "duration_ms", "via" }` です。
  `via` は `request` fixture を通した呼び出しなら `"request"`、page 自身が行ったもの(`page` のナビゲーションや page 内の `fetch`/XHR)なら `"page"` です。
  どちらの経路のエントリにも必ず付くため、読み手はその行がどちらの経路から来たかを形だけから推測せずに済みます。
  page の通信のうち http.jsonl に届くのは `document`、`xhr`、`fetch`(Playwright 自身の `request.resourceType()`)のリクエストだけです。
  実際のページ読み込みは画像やスタイルシート、スクリプトを何十件も引き込みますが、それを受け入れ確認の目的で読み手が 1 つずつ追うことはなく、そのすべてを保持しようとするファイルはそもそも読み手が開けるものではなくなってしまいます。
- `evidence.attachments`(空でないときだけ現れます)は、`evidence.attach`/`evidence.path` がこの実行で実際に書き込んだものを、`{ "name", "file", "at" }` の形でそれぞれ並べたものです(「Context API」を参照)。
  `name` は step が頼んだ名前、`file` は実際にディスクへ書かれたファイル名で、`evidence.dir` からの相対パスです。
  この 2 つが違うのは、同じ `name` がこの実行で 2 回以上使われたときだけです。
  2 回目以降の使用には、拡張子の手前に `-2`、`-3`、... が挿入され、最初のファイルを上書きすることはありません(`dup.txt` の次は `dup-2.txt` になり、`dup.txt` が黙って置き換わることはありません)。
  `at` は harness 自身が取得し、step が渡すことはありません。
  `attach` については書き込みが完了した時点、`path()` で払い出したファイルについては実行がその存在を確認した時点のそのファイル自身の mtime です。
  これは `sections`/`polls`/`evidence.screenshots[].at` がすでに従っている、計測であり宣言ではないという同じ規則であり、attachment を同じ絶対的なタイムラインに乗せます。
  `path()` を呼んだだけで、返されたパスに何も書かれなければ、エントリは 1 つも現れません。
  ディスク上に存在すると確認できたファイルだけが載るという、`evidence.http`/`evidence.trace` がすでに従っている「証跡は存在するファイルだけを指す」規則と同じです。
  `path()` で払い出したファイルが実際に書かれたかどうかは、harness が確認して決めるのであって、fixture 自身が呼び出しを覚えておいて決めるのではありません。
  パス区切りを含む、あるいは `.`/`..`/空文字列のいずれかと等しい `name` は、何も書き込む前に拒否され、黙って安全な形に書き換えられることはありません。
  100 件で上限を設け、`at` で並べ替えます。
  `page_events`/`actions` と同じ規約です。
  その上限に達したときの真の総数は、下記の `truncated.evidence` に載ります。
  `truncated.actions` がすでに使っている、同じ兄弟フィールドです。
  receipt の `name`/`file` という文字列は、他のどのフィールドとも同じ 1 回の redact を通ります。
  attachment 自身のファイルの *中身* は決して redact されません(任意のバイト列を redact すれば、保護するのと同じくらいの頻度で壊してしまうからです)。
  `attach` に渡すものを secret 抜きに保つのは、step 自身の責任です。
- `http_omitted`(少なくとも 1 件の page 由来のリクエストが省かれたときだけ現れます)は、その省略が黙って起きないようにするためのものです。
  http.jsonl に入らなかった分をリソースタイプ別に数えます。
  例えば `{ "image": 34, "stylesheet": 5, "script": 12 }` です。
  `observed`(上記)はこれによって一切狭められません。
  image や script の通信も含め、harness が見たリクエストをすべて数え続けます。
  それは http.jsonl とは違う問い(実際に何回の読み取り・書き込みが起きたか)に答えているのに対し、http.jsonl が答えるのは(そのうちどれが 1 つずつ読む価値があるか)という別の問いだからです。
  2 つの数は互いに一致することを期待されておらず、どちらかがもう一方より小さくてもバグではありません。
- `used`(空でないときだけ現れます)は、この実行が値を引き出した以前の実行の一覧です。
  `from` による注入、`resultOf` の呼び出し、あるいは `nuka do` での `--use` の receipt のいずれかを通じたものです。
  どの経路もライブラリのコードを通るため、読み取りは計測されるのであって宣言されるのではありません。
  各エントリは `{ "receipt": "rcpt-…", "step": "create-project" }` の形です。
  step 名は引用元の receipt と重複していますが、それでも書き留めます。
  読むために他のファイルと突き合わせなければならない receipt は、単独で読める receipt より劣った受け入れの記録であり、突き合わせる相手になるファイルはローカルな作業記録にすぎず、sign-off(「Sign-off」を参照)よりずっと先に寿命が尽きるからです。
  エントリは receipt id で重複排除され、最初に読まれた順に並びます。
  依存関係はこうして二重に可視になります: 静的には `from` か import として、実行時には receipt 連鎖の provenance としてです。
  値がどの上流の *step* から来たかは、その step ファイルが書かれた時点ですでに決まっていました。
  そのどの *実行* が値を供給したかは、ここでしか分かりません。
- **失敗した** step の receipt に限り、各 `used` エントリは追加で `result` を持ちます。
  id/step のすぐ隣に置かれる、上流の receipt のバリデーション済みの result 全体です。
  これにより、step が実際に何を見たかを確かめるためだけに 2 つ目の receipt.json を開かなくても、失敗した receipt 単体を読むだけで済みます。
  `ok` な receipt の `used` エントリが `result` を持つことは決してありません。
  重要だった値はすでにその step 自身の `result`(`from` 経由で入ってきた場合は `args`)に載っているため、そこで上流の値を繰り返しても冗長になるだけだからです。
  運ぶのは result 全体であり、`from` の注入や `resultOf` の呼び出しがたまたま読んだ 1 つのキーに絞り込まれることはありません。
  失敗を診断するのに必要なのは、どのキーが参照されたかではなく、上流の値が *なぜ* そうなったかだからです。
  参照されたキーに絞り込んでしまうと、receipt 側で同じ罠を作り直すことになります。
  それは「後続の step が参照するものを返す」という、参照だけに頼る罠であり、「型付き step」ですでに戒められているものです。
  これはまた、このフィールドが運べるのは上流の step 自身の `returns` スキーマがそもそも保持していたものだけだということも意味します。
  値を落とす `returns` は、ここからもその値を落とします。
- `sections`(空でないときだけ現れます)は、この実行中に行われた `section` の呼び出しを、`{ "label": "...", "at": "..." }` の形でそれぞれ、呼ばれた順に並べたものです。
  `used` と違って重複は除きません。
  ループやリトライで 2 回入ったラベルは 2 回入ったのであり、配列はそのとおりに読めるべきです。
  一方 `used` が receipt id を 1 回しか名指ししないのは、id が一連の中の一点ではなく、1 回引用する価値のある identity だからです。
  `at` は当初省かれていました。
  `sections` が答える問いは「どこで遅かったか」ではなく「どこで実行が止まったか」だという理屈からでしたが、それは半分しか正しくないとわかりました。
  ラベル 1 つだけでは、ある段階に到達したことしか言えず、この同じ receipt が運ぶ他の何に対して *いつ* だったかは言えません。
  実際の run がまさにその隙間を露呈させました。
  `status: "failed"` の隣に、対象がまだ存在していることを示す `final.png` が、およそ 8 秒違いで並んでいたにもかかわらず、receipt にはそれを言うものが何もありませんでした。
  額面どおりに読めば状態が点滅していたように見え、実際にそう誤診断されました。
  `at`(ISO 8601。`section` が呼ばれた時点でコレクタ自身が取得し、step が渡すことはありません)は、すべてのラベルを、`started_at`/`finished_at`、`polls` 自身の `at`、`evidence.screenshots[].at` がすでに共有している同じ絶対的なタイムラインに乗せます。
  これにより、「状態が実際に変化したのか」と「その読み取りは状態が落ち着く前に行われたのか」が、receipt 単体からは見分けが付かない状態でなくなります。
  失敗した step の `sections` も、失敗するまでに到達したラベルをそのまま保持しており、その配列の最後の要素がすでに「どの段階にいたか」に答えているため、同じ事実の置き場所をもう 1 つ作る `error.section` フィールドは別途ありません。
  `section` を持つのは typed step の fixture bag だけで、compat step には `this` 上に対応するものがないため、`sections` は単に省略されます。
  これは、typed step が一度も chain から読み取らなかったときに `used` が省略されるのと同じです。
- `polls`(空でないときだけ現れます)は、この実行中に完了したすべての `poll` 呼び出しを記録します: `description` が渡されていればそれ、`at`(その呼び出しが始まった ISO 8601 の時刻)、predicate が実行された回数、経過したミリ秒、そしてどう終わったか(`resolved`、`timed_out`、あるいは predicate 自身が投げた場合の `failed`)です。
  呼び出し順ではなく完了順です。
  入れ子になった poll は、それを内包する poll より先に完了し、完了した poll だけが述べるべき件数を持つからです。
  timeout した poll も他と同じように記録されます。
  その timeout で失敗した step の receipt こそが、まさにその数値が求められる場所だからです。
  `sections` と違って `polls` は、裸のラベルを超えたタイミングを常に運んでいました。
  それが存在する理由がタイミングの問いだからです: 0ms での 1 回の試行は、条件がすでに真だったこと、つまり待ちが no-op だったことを述べ、20 秒かけての 40 回の試行は、それが本当に遅かったことを述べます。
  この 2 つは step の外からは同じに見えながら、正反対の直し方を求めます。
  `at` は欠けていた半分、すなわち長さだけではない絶対的な開始点を加えるものであり、これにより poll は、測る基準点を持たない長さとして読まれる代わりに、`sections` と `evidence.screenshots` がいま共有しているのと同じタイムラインに置けるようになります。
  compat step にはそれを呼び出す fixture bag がなく、`polls` は単に省略されます。
  これは `sections` が省略されるのと同じです。
- `required_env`(空でないときだけ現れます)は、この実行中に `requireEnv` が呼ばれた名前を、初めて読まれた順に重複なく並べたものです。
  `used` や `sections` がすでに持っているのと同じ、宣言ではなく計測という形です。
  `requireEnv` はライブラリが制御できる唯一の呼び出し口だからです。
  キーが見つからず投げる前に記録されるため、`MissingEnvError` で失敗した実行の receipt にも、その step が何を要求したかが残ります。
  記録されるのは名前だけで、値は決して記録されません。
  値は secret になり得るからです。
  `env[name]` を直接読んだ場合はここには残りません。
  このフィールドが数えるのは `requireEnv` を通った読み取りだけで、ライブラリが関知しないプレーンなオブジェクトの読み取りは含まれません。
- `page_events`(少なくとも 1 つの種類が空でないときだけ現れます)は、step が動いている間に browser context 自身が見たものを記録します。
  console error(`console.error` の呼び出しだけを対象とし、warning は対象外です。
  ほとんどの SPA は warning を日常的に出すため、それはノイズになります)、page 自身が投げた捕捉されないエラー(`BrowserContext` の `weberror`。
  `Page` の `pageerror` に相当する context 側の対応物です)、そしてネットワークレベルで失敗したリクエストの 3 種類です。
  service worker は、browser context が見ているものの外側にあります。
  `BrowserContext` のイベントが対象とするのは context 内の page であって worker ではなく、また Playwright の `Worker` 型が持つのは `close` と `console` だけで、耳を傾けられる request や error のイベントはありません。
  そのため service worker が出す console と、その中で起きるバックグラウンドの fetch 失敗は、どちらも記録されません。
  cucumber-js には、これらを保持する browser context がそもそも存在しません。
  step は(`status: "ok"` のまま)裏で page がずっとエラーを投げていても pass することがあり、このフィールドが無かった頃は receipt にはそれを言うものが何もありませんでした。
  各種類は、少なくとも 1 件記録されたときだけ現れます。
  常に素の配列であり、件数によって種類自身の型が変わることはありません。
  `console_errors` は各エントリが `{ "text", "location": { "url", "lineNumber", "columnNumber" }, "at" }`、`page_errors` は各エントリが `{ "message", "at" }`(エラー自身の stack は決して含みません。
  trace.zip がすでに全体を運んでおり、stack を足しても redact が届くべき範囲を広げる割に得るものが少ないからです)、`failed_requests` は各エントリが `{ "method", "url", "failure", "at" }` です。
  `at`(ISO 8601)はコレクタ自身が取得します。
  `sections`/`polls` がすでに従っている、宣言ではなく計測という同じ規則です。
  種類ごとに 100 件で上限を設けます。
  リダイレクトループやうるさい page は 1 つの step で数千件を出しうるため、それをすべて保持しようとする receipt は、読み手が開けるものではなくなってしまいます。
  上限に達した種類は素の配列のまま(引き続き 100 件が上限)であり、代わりに自分の名前を `page_events` の兄弟フィールド `truncated` に追加し、そこへ本当の総数を対応付けます。
  少なくとも 1 つの種類が実際に打ち切られたときだけ現れます。
  `"truncated": { "console_errors": 4213 }` という形です。
  以前のバージョンは同じ事実を、打ち切られた種類自身を `{ entries, total, truncated: true }` に変えることで報告していました。
  そのため件数によって種類自身の型が変わり、読み手はそこから件数を読む前にその型を判定して分岐する必要がありました。
  兄弟フィールドがある理由は、どの種類も常に同じ形のままにし、打ち切りは 1 か所で 1 回だけ報告される別の事実にするためです。
  他のどのフィールドとも同じように redact されます。
  secret はコンソールのテキストにも、失敗したリクエストの URL にも、他のどこにと同じくらい容易に載りうるため、このフィールド専用の別の redact 経路は存在しません。
  成功した step の receipt にも失敗した step の receipt にも、同じように現れます。
  page のエラーは page についての証跡であり、step についての判定ではないからです。
- `actions`(空でないときだけ現れます)は、この step 自身の trace chunk(上の `evidence.trace`)から読み出されます。
  この step が `page` fixture を通して行った Playwright の呼び出しすべてで、`expect` の待ちも含み、trace が完了を記録した順に並びます。
  `expect` も fixture ではありません(「Context API」を参照)。
  step は Playwright のテストファイルと同じやり方(`import { expect } from "playwright/test"`)でそこにたどり着き、trace はそのラッパーの下、Playwright 自身の層でその呼び出しを記録します。
  `goto`、`click`、その他すべての呼び出しがすでに同じ場所に載っているのと同じです。
  各エントリは `{ "method", "expression"?, "selector"?, "url"?, "is_not"?, "timeout_ms"?, "ms", "outcome", "at" }` です。
  `method` と 5 つの任意フィールドは trace 自身の呼び出しからそのまま写され、`ms` はその呼び出し自身の所要時間を trace 自身の時計で測ったもの、`outcome` は trace がその呼び出しに error を記録していれば `"failed"`、そうでなければ `"passed"` です。
  `at`(ISO 8601)は trace 自身の monotonic clock から絶対時刻に変換したもので、`actions` を `sections`/`polls`/`evidence.screenshots[].at` がすでに共有しているのと同じタイムラインに載せます。
  5 つの任意フィールドは allowlist であり、その呼び出しが運んでいたものすべてではありません。
  `setContent` 呼び出し自身の HTML 本文は一例ですが、数キロバイトに達することもあり、trace.zip にすでに全体があるのに receipt にそれを必要とするものは何もないからです。
  上限は 100 件で `page_events` と同じ規約であり、上限に達したときに真の総数を報告する兄弟フィールド `truncated` も同じです: `"truncated": { "actions": 214 }`。
  `evidence.attachments` 自身の打ち切り(上記)も同じフィールドを通じて報告され、`truncated.evidence` として現れます。
  同じ実行で両方の上限に達したときは `truncated.actions` と並んで現れ、片方だけのときはそちらだけが現れます。
  他のどのフィールドとも同じ 1 回の redact で覆われます。
  secret は `url` や `selector` にも、他のどこにと同じくらい容易に載りうるため、このフィールドにも専用の別の redact 経路はありません。
  trace chunk がそもそも読めないとき(壊れている、あるいは step が `page` を一度も分割代入せずそもそも開かれなかったとき)は `actions` は黙って失われます。
  このリストにある他のどの evidence 読み取りフィールドもすでに従っている、計測が実行を壊してはならないという同じ規則です。
  唯一の声を上げる例外は、この build が認識しない trace format のバージョンです。
  検証していない形を推測することは、何も報告しないことより悪いため、`actions` はやはり省かれますが、`nuka run`/`nuka do` は stderr にも一度だけ警告します(`warning: trace format version <n> is not readable by this build; step actions were not recorded`)。
  `evidence.trace` は確かに存在するのに `actions` だけが黙って空になっていると、それは「この build が読めなかった」ではなく「何も起きなかった」と読めてしまうからです。
- Before/After/AfterStep フックには自分自身の receipt がありません(「Compat steps」を参照してください)。
  そのため、その呼び出し自身の trace 証跡は代わりに scenario record の `hooks` 配列にあるその呼び出し自身のエントリに載ります。
  `trace`(receipt dir ではなく scenario 自身の directory からの相対パスです。hook には receipt dir 自体がありません)、`actions`、`truncated` は、上と全く同じ形で、全く同じ規則のもとで現れます。
  hook の呼び出しには `sections`/`polls` は並びません。
  どちらも typed step の `section`/`poll` fixture から来るものであり、hook はどちらを呼ぶための fixture bag も持たず、持つのは World(`this`)だけだからです。
  hook 自身が明示的に呼んだものではなく trace chunk 自体から読み出される `actions` は、この gap の影響を受けません。
  ブラウザに一度も触れなかった hook の呼び出しは chunk を開かず、この 3 つのフィールドのどれも運びません。
  `page` を一度も分割代入しなかった step と同じです。
- `fixtures`(空でないときだけ存在します)は、その step 自身の bag 解決が実際に触れた `config.fixtures` エントリすべてを列挙します。
  `{ "name", "scope", "setup_ms"?, "at"?, "reused" }` です(完全な形と、`setup_ms`/`at` が新しく構築されたエントリにしか存在しない理由は「Fixtures」を参照)。
  teardown 自体はこのリストに含まれません。
  teardown はこの receipt がすでに閉じたあとに走るので、`scenario` scope の fixture 自身の teardown 失敗は scenario record の `teardown_errors` に載ります(「Fixtures」を参照)。
- receipt は state directory(`.nukadoko/`、gitignore 対象)の下に置かれます。
  それらはローカルな作業記録であり、耐久性のある成果物は sign-off です。

## Session、environment、secret

Cucumber が持ったことのない実行インフラです:

- **Session** は Playwright の storageState として、CLI の呼び出しをまたいでログイン状態を運び、environment ごとに保存され、同時に 1 つの実行にだけ advisory lock されます。
  `--session` を指定しないことはクリーンな開始を意味し、暗黙に共有される状態はありません。
  daemon はありません。
- **Environment** はデプロイ先に名前を付けます。
  environment ごとの `baseURL`、`envFiles`、`policy: "read-only"`(mutate する step を拒否する)、そしてすべての receipt に `target_version` として記録される、任意の `version` プローブです。
  sign-off は両方を凍結するので、記録はそれが green だったデプロイ先を名指しします。
- **Secret**。
  git が分類するのは「出自」です。
  git が追跡していない env file(ignore されているか untracked。この 2 つは区別されません)は secret の源です。
  そこで定義される値はすべて secret であり、宣言は不要です。
  追跡されている env file はただの設定です(コミットされた値は secret ではなく、nukadoko もそうではないふりをしません)。
  git リポジトリの外では、すべての envFile が secret の源として扱われます。
  ただし出自と「扱い」は別の問いです。
  `secrets.public` は個々の secret 源のキーを降格し、二度と redact しません。
  `secrets.redact` はその逆で、追跡済みファイルの個々のキーを名指しし、それでも redact します。
  `redact` は git 自身の出自判定に異を唱えるものではなく、あるキーが secret 源ファイルに含まれるのと同じ意味で「secret である」という主張でもありません。
  それは、リポジトリがすでにその値を持っているからといって、新しい面(ターミナル、CI ログ、誰かが貼り付けるバグ報告、エージェント自身の会話ログ)にその値を広げないでください、という指示です。
  どちらの出自も同じ token、`{{secret.NAME}}` を共有します。
  2 つ目の `{{redacted.NAME}}` マーカーはなく、receipt を読む側は redact の形を 1 種類だけ覚えればよいということです。
  同じキーを `public` と `redact` の両方に名指しすることはできません。
  それは config エラーです。
  2 つのリストは、1 つのキーについて正反対の指示を与えるからです。
  secret の値は、出自にかかわらず、receipt が出力されるあらゆる場所(receipt.json、`do` の stdout コピー、http.jsonl)で `{{secret.NAME}}` として redact されます。
  これは書き込み時に executor によって適用され、step の `run` から制御することは決してできません。
  正直な限界もあります。
  4 文字未満の値は決して redact されません(この下限は `redact` で名指しされた値にも、他の secret とまったく同じように適用されます)。
  redact できるのは nukadoko 自身が読み込んだ値だけです。
  step の result の中で新たに生まれた token は捕まりません。
  そして `secrets.redact` に名指しされていない追跡済みの値は、それらの面のすべてに平文のまま届きます。
  エージェント自身の会話ログも含めてです。
  その会話ログは、`.gitignore` の追跡/未追跡という線が引かれた時代にはまだ存在しておらず、「すでにリポジトリにある」がその会話ログについての判断だったことは一度もありません。
  Trace とスクリーンショットは redact されません。
  state directory は機密性の高いものです。
  `nuka check` は各 env file の分類と secret のキー名を報告し(値は決して報告しません)、さらに 3 つの warning を出します。
  1 つ目は、`secrets.public`/`secrets.redact` が、設定されたどの envFile にも定義されていないキーを名指ししている場合です。
  2 つ目は、`secrets.redact` が、値が短すぎて実際には redact されないキーを名指ししている場合です。
  3 つ目は、追跡済みの env file についてだけ、キーの「名前」が secret を保持しているように見える(`SECRET`、`PASSWORD`、`TOKEN`、`CREDENTIAL`、または `KEY` で終わる)のに `secrets.redact` に名指しされていない場合です。
  最後のこの検査は名前パターンによるヒューリスティクスであり、使い道はただ 1 つ、warning を出すかどうかを決めることだけです。
  それが redact を決めることは決してありません。
  名前が secret に「見える」ことは、実際に redact されるものを増やしはしません。
  それを決めるのは git の追跡/未追跡の分類と `secrets.redact` だけです。

Configuration は `nukadoko.config.ts`(`defineConfig`)の中にあります: `featuresDir`(デフォルトは `features`。feature ファイルと step のコードは両方ともこの下に置かれる、Cucumber 流のやり方です)、`additionalFeatureDirs`、`baseURL`、`envFiles`、`environments`、`stateDir`(デフォルトは `.nukadoko`)、`browserType`、`browser`、`browserContext`、`requestContext`、`secrets`、`parameterTypes`、`fixtures`、`fixtureTimeout`(「Fixtures」を参照)、`allure`(`resultsDir` のみ。Allure emitter を参照)、`messages`(`output` のみ。Messages emitter を参照)。

`additionalFeatureDirs`(デフォルトは `[]`)は、`featuresDir` とは違う問いに答えます。
`featuresDir` は無人で *実行される* 集合です。
引数なしの `nuka run` はちょうどそのディレクトリだけを反復し、このキーがそれを広げることは決してありません。
`featuresDir` と `additionalFeatureDirs` を合わせたものが、静的チェックが語彙を *結び付ける* 対象となる集合です。
引数なしの `nuka check` と `nuka tend` はどちらもこの広い集合を歩きます。
ある step の pattern が結び付けられているかどうかはプロジェクト全体の性質であり、今日の無人の run が何を実行するかの性質ではないからです。
だからこそ acceptance feature(「Sign-off」を参照)は `additionalFeatureDirs` に属します。
acceptance feature が `featuresDir` の外に置かれているのは、まさに回帰として拾われることが決してないようにするためです。
`additionalFeatureDirs` にそのディレクトリを名指しすれば、その feature が結び付ける step は `pattern-unbound` として報告される代わりに結び付けられていると数えられ、それでいてなお無人では実行されません。
ディスク上に存在しないエントリは config の誤りであり、空のスキャン結果として素通りさせてよいものではありません。
`nuka check` はそれをエラー(`additional-feature-dir-missing`)として報告し、`nuka tend` は同じ事実を注記として報告します。

`browserType` は `ctx.page()` が起動する Playwright のエンジンを選びます: `"chromium"`(デフォルト)、`"firefox"`、`"webkit"` のいずれかです。
これは `browser` の中のフィールドではなく、別のキーです。
`browser` 自身の型である `LaunchOptions`(下記参照)には、エンジンを選ぶキーがそもそも無いからです。
Playwright はエンジンを、`chromium`/`firefox`/`webkit` のどの名前空間から `launch` を呼ぶかで選びます。
渡すオプションでは選びません。
エンジンを選ぶキーを `browser` に混ぜてしまうと、`LaunchOptions` 自体には存在しないキーを受け付けることになり、`browser` 自身の「Playwright の型をそのまま渡す」という契約が壊れます。
firefox と webkit はそれぞれ専用のバイナリのインストールが必要です(`npx playwright install firefox`/`webkit`)。
すでにインストール済みかどうかは、実際に起動してみないと分かりません。
そのため `nuka check` はそれについて何も主張しません。
バイナリが無い場合は、Playwright 自身のエラーがそのまま起動時に現れます。
握り潰したり言い換えたりはしません。
scenario record 自身の `browser` フィールド(「実行」を参照)には、run が実際に起動したエンジンとバージョンが、同じように計測されて載ります。

`browser` は Playwright 自身の `LaunchOptions` 型をそのまま受け取ります。
zod は「これがオブジェクトかどうか」以上には形を再検証しません。
型は `defineConfig` から来るため、`tsc` は `nukadoko.config.ts` の他の場所と同じやり方で typo を捕まえます。
Playwright のオプションを zod で列挙し直すと、Playwright が 1 つ追加するたびに追随が必要になり、その追随が追いつくまでのあいだ、config を書く人は本当は使える Playwright のオプションを使えなくなってしまいます。
今日読まれているのは `headless` だけで、選ばれたエンジン自身の `launch` にそのまま渡されます(どのエンジンかを選ぶのは上記の `browserType` です)。
省略した場合は Playwright 自身の既定値(`headless: true`)が適用されます。
`newContext` の `viewport` のようなオプションは別の Playwright の型であり、この `browser` キーでは受け付けません(下記の `browserContext`/`requestContext` を参照)。

`browserContext` と `requestContext` は、`browser` の `launch` に対応する `newContext` 側のキーです。
`browser.newContext()`(step の bag が `page` を名指すと構築されます)と `playwrightRequest.newContext()`(step の bag が `request` を名指すと構築されます)は別々の Playwright 呼び出しであり、オプションの型も別々なので、1 つの共有キーではなくそれぞれに専用のキーを用意しています。
これは `browser` が従っているのと同じ「Playwright 自身の型に委ねる」方針です。
これにより `ignoreHTTPSErrors` のようなオプションに初めて手が届くようになります。
自己署名証明書を使うローカルの接続先では、どちらの fixture にもそれを設定する手段がこれまでありませんでした。
どちらのキーも `baseURL` と `storageState` は理由を述べたエラーで拒否し、黙って無視することはしません。
`config.baseURL` はプロジェクトの base URL の唯一の出所であるべきであり、`storageState` は nukadoko 自身の session 機構が設定するものなので、ここでも受け付けてしまうと config が自分自身と静かに食い違う値を持つことになるからです。

`parameterTypes` のエントリは、カスタムの cucumber-expressions parameter type を登録します(`{ name, regexp, transformer? }`)。
たとえば `{ name: "negation", regexp: /( not)?/, transformer: (s) => s === " not" }` は、`will{negated:negation} return` という pattern を素の `z.boolean()` の args キーに結び付けられるようにします。
登録が config に住むのは、config が既に実行可能な TypeScript だからです(version probe が関数である理由と同じです)。
nukadoko には登録を置くための support ファイルという形式がありません。
名前は組み込み型と衝突してはなりません。
`{int}` の意味をプロジェクトごとに再定義できてしまうと、それを使うすべての pattern の意味が静かに変わってしまうからです。
transformer は型強制であり、契約であり続けるのは args のスキーマです。

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

- `receipts/<id>/`(receipt ごとに 1 つのディレクトリ: receipt の JSON とその evidence ファイル(trace.zip、screenshots、http.jsonl))
- `scenarios/<id>/`(scenario の実行ごとに 1 つのディレクトリ: `record.json`、scenario 自身の最終スクリーンショット、そしてブラウザに触れた Before/After/AfterStep フックの呼び出しごとの trace chunk)。
  各呼び出しに一意な名前が付きます(例えば `hook-before-0.zip`、`hook-after_step-1-2.zip`)。
  複数の hook がこの 1 つのディレクトリを共有しうるからです。
  自分自身の `receipts/<id>/` を決して共有しない step とは違います。
  これは Playwright 自身のテストごとの `test-results/` という規約を 1 階層上でなぞったものです。
  scenario 全体をまたぐ trace.zip はここにはありません。
  各 step 自身の trace は、その step 自身の `receipts/<id>/` の下に置かれます(「実行」を参照)。
- `sessions/<env>/<name>.json`(storageState。生の認証情報を平文で持ち、制限されたパーミッションで作成されます)
- `allure-results/`(emitter の出力。run をまたいで追記され、新しい Allure launch が欲しければ削除してよい)。
  `init` もこれを空のまま作ります。
  Allure 自身の CLI は、存在しないディレクトリでは起動を拒む一方、空のディレクトリなら受け付けるからです。
  これにより、最初の `nuka run` より前から `allure watch` を起動しておけます。
- `messages.ndjson`(messages emitter の出力。run ごとに 1 つのストリームで、`nuka run` のたびに先頭が truncate される。Messages emitter を参照)

耐久性のある成果物はその代わりにリポジトリの中に置かれます: feature ファイル、型付き step、sign-off の記録です。

## Sign-off

sign-off は、合意された scenario が、名指しされた 1 つの commit で green だったことを記録します。
それは受け入れのために存在し(チケットの基準が一度満たされたことを確認する)、regression のためではありません。
scenario はチケットの受け入れ基準から書かれ、green になるまで実行され、その後記録として保持されます。
後で再実行することが目的ではなく、nukadoko の中で再実行するものは何もありません。

```sh
nuka run acceptance/PROJ-123.feature     # execute, as often as needed
nuka accept acceptance/PROJ-123.feature  # freeze the last green run
```

- `accept` は実行しません。
  sign-off は明示的な行為であり、green な run の副作用ではありません(「通るまで accept し続ける」は意味のあるループではありません)。
  それはその feature の直近の green な run を取り、それを凍結します。
  run は feature のパスで識別され、id では識別されません(run id は `nuka run` の出力を読む機械のためにあり、人間が入力するものではありません)。
- 凍結する run は feature 全体をカバーしていなければなりません。
  `<feature>:<line>` で選ばれた run は 1 つの scenario しかカバーしていないため、どれだけ green であっても候補にはなりません。
  それを凍結すれば、その run が実際には到達していない feature の大部分の隣に記録が残ってしまいます。
  結果として起こり得る 4 通りは、読む人にとってそれぞれ別の状況であり、別のものとして報告されます: この feature の run が一度も存在しない、直近のフル実行が red だった、部分実行しか存在しない、あるいは green なフル実行は存在するが現在の条件の下ではない(後述)、のいずれかです。
  拒否は、判断に使った内容(どの run か、いつ始まったか、どの scenario が失敗したか、あるいはどの条件なら run があるか)を名指しするので、次のコマンドは当てずっぽうではなく記録に基づいて選べます。
- sign-off は条件にスコープされます。
  条件とは `(environment, browser)` のことで、どちらも run 自身の計測から読まれ、宣言からは読まれません。
  `environment` は `nuka run` 自身の `--env`(または暗黙の `default`)です。
  `browser` は run が実際に起動したエンジンを計測した `ScenarioRecord.browser` で、ブラウザを起動した run にだけ存在します(「実行」を参照)。
  「chromium では受け入れたが firefox ではまだ」は正常な状態であり、古びた状態ではありません。
  sign-off は 1 つの特定の計測済み条件についての主張であり、その 2 つを凍結することは 2 つの別々の主張であって、1 つの主張の更新ではないからです。
  `nuka accept` は自分自身の `--env` を取り、`nuka run` 自身のそれとまったく同じやり方で解決したうえで、両方の軸で現在の条件に一致する run だけを候補にします。
  `environment` は各候補自身が計測した `environment` と照合し、`browser` は現在の条件である `config.browserType` と、各候補自身が計測した `browser.type` とを照合します(この仕様の他のあらゆる宣言/計測の問いと同じ「計測 vs 計測」の比較であり、逆向きではなく、候補が単に宣言しただけの値と照合することも決してありません)。
  ブラウザを一度も起動しなかった run は、`browserType` に関係なく候補になります。
  計測されていない軸は、その run が実際に確認したものの一部ではなく、これが API だけの scenario の受け入れがエンジンの選択に依存しない理由です。
  一致する run が 1 つもないとき、拒否は green なフル run が存在するすべての `(environment, browser)` の組を代わりに列挙します。
- working tree が完全にクリーンで(untracked file を含む)、かつ凍結しようとしている run が現在の HEAD で行われたのでなければ拒否します。
  記録の主張はまるごと「この scenario は commit X で green だった」というものです。
  discovery が読み込んだはずの untracked な step ファイルや、run と sign-off の間に行われたコミットは、その主張を偽にします。
  scenario record はこれをチェック可能にするために 1 つのフィールドを増やします(run が始まったときに working tree がどの commit にあったか)。
- red な run は何も生みません。
  verdict のフィールドも失敗の記録もありません(通らなかった scenario は直されて再実行され、残す価値があるのは結果であって、試行そのものではありません)。
- 記録は、それが由来する feature の隣に `<feature-basename>.<date>-<sha>.<environment>.<browser>.md` という名前で書かれ、accept した run 自身の条件が名前に織り込まれます(`<browser>` は、run がブラウザを一切起動しなかった場合は文字どおり `no-browser` になります)。
  こうすることで、同じ commit の同じ日であっても、2 つの条件が衝突して互いを黙って上書きすることがなくなります。
  browser の**バージョン**はファイル名には決して入りません。
  エンジンの種別だけで、その記録がどの条件のものかを識別するのに十分だからで、バージョンは記録の本文にだけ残ります(後述)。
  nukadoko はディレクトリを選びません(受け入れの作業をどこに置くかはプロジェクトの決定です)。
  これらを regression suite から外したいプロジェクトは feature を `featuresDir` の外に置き、記録もそこに追従します。
- 記録本文自身は、冒頭近くに「Condition」節を運びます: `environment` と、accept した run がブラウザを起動していればその計測済みのエンジンとバージョンです。
  起動していなければ、空欄のままにするのではなく、その節がそのことを明示します。
  こうすることで「ブラウザを起動しなかった」ことと「読み手が確認し忘れた」ことが区別できるままになります。
  この節ができる前に accept された記録にはこの節がありません。
  `nuka tend` はそれを「条件不明」として扱い、条件を推測することは決してなく、この節による比較の対象にすることもありません(「手入れ」を参照)。
- それは feature の全文、scenario record、そして evidence を取り除いた各 step の receipt を運びます(trace とスクリーンショットは `.nukadoko/` に留まり、それらが必要になったときの居場所は CI の artifact です)。
  コピーはツールが作り、人間が書き写すことは決してありません(書き写しは、計測を主張へと格下げしてしまいます)。
- 記録の末尾にはもう 1 つのセクション、「Declared vs observed」があります。
  記録の中のすべての scenario にまたがるすべての step のうち、receipt が `mutates: false` を宣言していながら、少なくとも 1 回の書き込みが計測された(`observed.http_writes > 0`、キーワードの意味論を参照)ものが対象です。
  それは生の事実として述べられます(宣言された値と観測された回数を並べるだけ)。
  verdict では決してありません。
  それは決して拒否しません(上記のどの拒否条件もこれを読みません)。
  POST の上で読み取る step は、それが accept されるたびにここへ載ることが、設計上想定されています(実行時の `mutates` の強制そのものを信頼できなくした、同じ HTTP メソッドというプロキシです、上記参照)。
  1 つの scenario ごとに散らすのではなく、1 つのセクションにすべての scenario をまとめます。
  そうすることで見落とされずに済みます。
  食い違いが 1 つもない場合でも記録され、「照合した結果ゼロだった」ことと「そもそも照合していない」ことが読み分けられるようにします。
  compat step(`mutates: null`、「compat step に欠けているもの」を参照)は `observed` と比較すべき宣言がそもそも存在しません。
  それは別に数えられ、上記のどちらの結果にも混ぜられません。
  「比較する対象がない」ことと「比較して一致した」ことは別の事実だからです。
- Gherkin にすでにその場所があるので、記録の中にはチケットへのリンクは何もありません。
  tag と `Feature:` の下の自由な説明文が、チケットの id、その URL、そしてレビュアー自身の言葉による受け入れ基準を運びます。
  feature を凍結すればそのすべてが凍結されます。
  nukadoko はチケットという概念を持たず、必要ともしません。
- plan のサブシステムも reasoning のフィールドもありません。
  「何がこれを証明するのか」という問いに答えるのは feature ファイルとそれが結び付く型付き step であり、scenario が本当にその基準を表しているという判断は、その翻訳が起きる場所、つまりその feature の PR レビューという git ネイティブなやり方で下されます。
  sign-off は、合意されたチェックが実際に実行されたことの記録です。

sign-off は常に過去形でしか語らず、それが requirements traceability matrix のように腐っていくのを防ぎます。
matrix はシステムの今の姿を記述すると主張するため、システムが動いた瞬間にずれていきます。
「commit X で green だった」は永遠に真であり続けます。
記録があえて主張しないのは、ソフトウェアが今日もその振る舞いを保っているということです。

### 受け入れループ

チケットの受け入れ基準を渡されたとき、agent が行うことです。

1. 語彙を読みます(`nuka steps --json`、そして関連しそうなものの契約については `nuka describe <step>`)。
2. 操作が欠けているときは `nuka scaffold <name>` し、それを実装し、receipt が正しく見えるまで `nuka do` で単体で動かします。
3. feature を書きます。
   tag と `Feature:` の下の説明文が、チケットの id とレビュアーの言葉による基準を運びます。
   scenario は、その基準を語彙に翻訳したものです。
4. 何かが実行される前に、`nuka check <feature>` を行います(未定義の step、pattern と schema の不一致、mutate する step に結び付いた Then)。
   受け入れの feature が置かれているディレクトリが `additionalFeatureDirs` に列挙されていない限り、パスを渡します。
   引数なしの `nuka check` は `featuresDir` とそのリストを歩くため、`featuresDir` の外に意図的に置かれ、どこにも名指しされていない feature こそが、まさにそれが届かない対象だからです。
5. commit します。
   run は、まだチェックアウトされているその commit で、クリーンな working tree に対して行われた場合にしか凍結できないため、dirty な working tree に対するデバッグ用の run はかまいません。
   ただそれらは accept できないだけです。
6. green になるまで `nuka run <feature>` します。
7. `nuka accept <feature>` し、それが書いた記録を commit します。

手順 1-4 が作業とレビューの場所です(新しい型付き step と feature 自体は通常の PR の題材であり、基準から scenario への翻訳こそがレビュアーがチェックするための判断です)。
手順 5-7 は機械的であり、ツールは静かに誤って進むのではなく拒否します。

## Allure emitter

`nuka run` は、step が終わるたびに、その step 1 つにつき 1 つの Allure test result を `allure-results/` ディレクトリに書き込みます(Allure 2 のファイル形式で、Allure 2 と 3 の両方で読めます)。
これが nukadoko の唯一の presentation 層であり、nukadoko 自身は何もレンダリングしません。

- 出力先はデフォルトで `.nukadoko/allure-results/` です(上で述べた state directory 自身の `allure-results/` です)。
  `nukadoko.config.ts` の `allure.resultsDir` で、root からの相対パスであれば他の任意の場所に移せます。
  `enabled` フラグも CLI フラグもありません。
  emitter は常に実行されるため、設定ゼロのままで既に完全なレポートが生成されます。
  唯一スキップされるのは `nuka run` の呼び出しが 0 件の pickle を選んだときで(その場合 `allure-results/` はまったく作られません)、これは BeforeAll/AfterAll がスキップされるのと同じ理由です。
- 書き込みは追記のみです: 既存の `allure-results/` ディレクトリがクリアされたり置き換えられたりすることは決してありません。
  2 回の `nuka run` の呼び出しを 1 つの Allure launch とみなすか 2 つとみなすかは呼び出し側に委ねられています。
  新しい launch が欲しいユーザーは、自分でそのディレクトリを削除します。
- `allure-results/` は `nuka run` がまだ実行中でも安全に読めます。
  そして、実行中に読めることこそが、step を単位にした理由そのものです。
  数分かかる 20 step の scenario は、これまで最後の step が終わるまでレポートが空白のままでした。
  Allure が result を持てる最小単位が scenario だったからです。
  いまは各 step 自身の result がその step の終了と同時に着地するため、すでに開いているダッシュボードは scenario 単位ではなく step 単位で更新されます。
  着地までの遅延は実測で 150〜351ms でした。
  `nuka init` はまさにこのために `.nukadoko/allure-results/` を空のまま先に作るので(「The state directory」を参照)、最初の `nuka run` が始まるより前から `allure watch` を起動しておけます。
  `categories.json`/`environment.properties` は run の最初、最初の step が始まる前に、一度だけ書き込まれます。
  run の途中でそのディレクトリに対して `allure generate` を実行すると、そこまでに着地した step がすべて報告されます。
  このディレクトリ自身の整合性は、run が完了しているかどうかに何も依存していません。
- 各 gherkin の step は、それ自身が 1 つの Allure test result になります。
  これまでのように、scenario の test の中にネストされた Allure step ではありません。
  scenario はその test の `suite` label になり、feature はこれまでどおり `parentSuite` のままです。
  Allure の既定のツリーはちょうどこの 2 つでグループ化するため、suite の行はこれまでと同じように scenario 全体の集計を持ち、その step のどれか 1 つが落ちればすぐに赤くなります。
  ただし `suite` スロット自身はこれまで空でした。
  各 Before/After フックは、これまでどおりそれぞれ独立した fixture(Allure container)になります。
- 自分自身の Before フックで止まった scenario は、いまやすべての step が `skipped` と表示され、失敗はその hook 自身の fixture の中でしか見えません。
  以前のように hook の失敗が 1 つの test を赤くする、その scenario レベルの test 自体がもう無いからです。
  `nuka run` 自身の exit code と、それが書く `record.json` はどちらの場合も影響を受けません。
  これはレポート表示上の制約であり、何が失敗したか、nukadoko が何を判定したかが変わったわけではありません。
- Attachment: step ごとに、その step 自身の trace、HTTP ログ、バリデーション済みの result が、その step 自身の test result に付きます。
  scenario 自身のスクリーンショット(`final.png`、teardown で 1 度だけ撮られます)は、代わりに "Scenario evidence" という名前の合成 fixture に付きます。
  これが撮られる時点ではすでにすべての step 自身の test がディスクに書き込まれ終えており、直接付けられる scenario レベルの test がもう残っていないからです。
  それとは別に、step が自分自身について宣言したもの(attachment、link、ログの一行)も出力され、常に `declared:` を接頭辞に付けた名前の下に置かれます。
  すべてが同じ result ファイルに収まったとき、この接頭辞こそが provenance(nukadoko によって計測されたのか、step によって自己申告されたのか)の生き残る唯一の場所です。
- receipt が存在する step には、合否を問わずすべて、その receipt 全体がそのまま `receipt.json` という attachment として付きます。
  これはディスクに書き込まれたのと同じオブジェクトです(そこですでに redact 済みなので、ここで 2 度目の redact は行いません)。
  フィールドごとに分解せず丸ごと添付しているのは意図的なものです: `receipt.json` に後からフィールドが増えても、emitter を変更しなくてもレポートに自動で届きます。
  下にある個別にマップされたフィールドもそのまま残ります。
  1 つの事実を知りたいだけの読み手が attachment を開かなくて済むようにするためです。
  `receipt.json` は、個別のマッピングが書かれていない場合でもレポートを完全に保つ、その受け皿です。
- step 自身の `sections`、`polls`、`actions`(「Receipt」を参照)は、その step 自身の test の直下にネストされた 1 本の child step タイムラインにまとめられます。
  これはこの変更より前より 1 段浅くなっています(以前は step 自身が scenario の test の中にネストされ、タイムラインはさらにその中にネストされていました)。
  マージは `at` の昇順です。
  同じミリ秒に複数の entry が重なったときは、`sections`、`polls`、`actions` の順という決まった並びを保ちます。
  同じ receipt を読み直すたびに順序が入れ替わって diff が読めなくなる、ということがないようにするためです。
  section は、自分のラベルを名前に持つ幅ゼロのマーカーとしてレンダリングされます。
  poll は自分の開始点から `waited_ms` 後まで幅を持ち、名前は `<description> (<attempts> attempts)` です。
  こうすることで、1 回の試行で解決した待ちと 40 回かかった待ちを、receipt を開かなくても読み分けられます。
  所要時間だけでは両者を見分けられず、その回数こそが名前でしか運べない唯一の事実だからです。
  poll 自身の outcome は child step の status を決めます: `resolved` は passed、`timed_out` は failed(待っていた条件が満たされなかった、つまり step 自身の契約が成立しなかった)、`failed` は broken(poll のコールバック自身が例外を投げた、それは何を待っていたかとは無関係)です。
  action は自分の開始点から `ms` 後まで幅を持ち、名前は自分の `method` に、呼び出しが持っていれば `selector` か `url` を添えたものです(例: `goto /orders`)。
  `expect` の呼び出しだけは代わりに matcher と対象で名付けられます(例: `expect #late to.be.visible`。否定された assertion では `not` が畳み込まれます)。
  `goto` の対象が `url` から自明であるのと違い、`expect` の matcher と対象はどちらも `method` だけからは分かりません。
  `ms` も `timeout_ms` も名前には決して入りません: `ms` は child step 自身の幅としてすでに見えており、これは `page_events` の件数を step の名前に入れない理由と同じです。
  `timeout_ms` は `receipt.json` という attachment の中にとどまります。
  action 自身の `outcome` は child step の status を passed か failed のどちらかに決め、第 3 の分類はありません: poll と違い、Playwright の呼び出しは step が求めた通りに解決したか、しなかったかのどちらかだからです。
  `actions` 自身が 100 件で打ち切られていたとき(「Receipt」の `truncated.actions` を参照)、タイムラインの末尾にもう 1 つ、幅ゼロで passed の child step が加わり、打ち切りの事実を名指しします(例: `... 4113 more actions not shown`)。
  これは `page_events` 自身の `truncated` フィールドが存在するのと同じ理由です: タイムラインだけを見た読み手が、打ち切られたリストを全部だと取り違えることが決してないようにするためです。
  親 step 自身の start/stop の範囲にクランプすることは決してありません。
  その範囲の外に出た timeline entry は実際に起きたことであり、隠せば読めなくなるだけで、起きなかったことにはなりません。
- hook の呼び出し自身の trace と `actions`(上の「Compat steps」を参照)は、test result 自身にではなく、その hook 自身の fixture に付きます。
  trace は `trace` という名前の attachment として、step 自身のものと同じ contentType で付きます。
  `actions` は、上のブロックが説明したのと同じ仕組みで、その fixture 自身の child step タイムラインにマージされます。
  hook には合流させる `sections`/`polls` がありません。
  `section`/`poll` を呼ぶための fixture bag を持たないからです。
  それでも trace から読み出された `actions` は、step のときと同じようにレンダリングされます。
  `this.openPage()` に一度も触れなかった hook の呼び出しは、trace の attachment もタイムラインの entry もどちらも持ちません。
  `page` を一度も分割代入しなかった step が「何も表示するものがない」のと同じです。
- `page_events`(「Receipt」を参照)は、最大で 3 つの parameter として表に出ます: `console errors (observed)`、`page errors (observed)`、`failed requests (observed)` です。
  それぞれ、少なくとも 1 件記録された種類だけに現れます。
  こうすることで、すべての entry を全文運んでいる `receipt.json` という attachment を開かなくても、読み手は件数を見られます。
  収集側が打ち切った種類(「Receipt」の `page_events.truncated` を参照)は、表示件数の隣に真の総数を示します(例えば `100 of 4213`)。
  表示件数だけでは、実際に起きたことを過少に見せてしまいます。
- step の parameter は、その宣言と実際に観測されたものを並べて運びます。
  計測された `http reads (observed)` / `http writes (observed)`(compat の step では `world reads (observed)` / `world writes (observed)` も)の隣に `mutates (declared)` が置かれます。
  この 2 つが自動で照合されるからではなく、レビュアーが自分の目で見比べられるようにするためです。
  宣言は nukadoko が信頼し作用する対象であり、observed の回数は実際に起きたことであり、この行は両者を目で見比べられる場所です。
  observed 側は意味論上の判定ではなく HTTP メソッドによるプロキシです(キーワードの意味論を参照してください)。
  step が POST ベースの読み取りを呼んでいた場合、正直な `mutates (declared): false` の隣にゼロでない `http writes (observed)` が並ぶことがありますが、それはこのプロキシがテーブルに透けて見えているだけであり、どちらの数値も嘘をついているわけではありません。
- さらに 3 つの parameter、`nukadoko.run`、`nukadoko.scenario`、`nukadoko.step` が、その step の run id、scenario id、位置をそれぞれ運びます。
  どれも `mode: "hidden"` なので、3 つとも UI には一切出ません。
  これらは、それぞれの step 自身の `historyId` を意図的に分けておくために存在します(詳しくは下を参照)。
  読み手に何かを見せるためのものではありません。
- 失敗した step のメッセージには `[nukadoko.failure=<kind>]` という接頭辞が付き、その receipt が既に持っている同じ `error.kind` を名指しします。
  同じ `error.kind` は `nukadoko.failure` という result label としても書き出されます。
  2 つの Allure 世代は、それを別々の経路で category に変換し、利用者に求めるものも異なります。
- **Allure 2** には result ごとの category フィールドが無いため、emitter は `categories.json` も書き出します(`error.kind` ごとに 1 つの rule、全 7 個、すべての run で、メッセージの接頭辞を正規表現でマッチさせます)。
  メッセージの接頭辞と category の rule は同じ分類を 2 つの視点から見たものであり、利用者側の設定は不要です。
- **Allure 3** の `allure generate`/`allure report` は、結果ディレクトリの `categories.json` を一切読みません。
  そこでの category は Allure 3 自身の config だけから決まり、result の label と照合され、`nukadoko.failure` はまさにそのような label です。
  `nuka init` はプロジェクトの root に `allurerc.mjs` を書き出し、`error.kind` ごとに 1 つ、7 個の label-matcher rule を持たせます。
  この 7 個の名前は `NAME_BY_KIND`(`src/report/allure/categories.ts`)から組み立てられるため、emitter 自身が使う名前と決してずれません。
  プロジェクトの root に置けば自動で検出されます(Allure 3 はカレントディレクトリから `allurerc.{js,mjs,cjs,json,yaml,yml}` を自動検出するため、`--config` フラグは不要です)。
  `init` はこの 6 つの拡張子すべてを先にチェックし、プロジェクトに既にどれか 1 つあれば何も書かず、見つけたファイル名を stderr に出します。
  そのどれも置かないと、すべての nukadoko の失敗は Allure 3 に組み込まれた 1 つの category「Product errors」に落ちてしまいます。
  `nuka init` を使わないプロジェクトは、[`examples/allure/allurerc.mjs`](https://github.com/meganemura/nukadoko/blob/main/examples/allure/allurerc.mjs) を手でコピーして置くこともできます。
- **`fullName`(`<feature のパス>#<scenario の名前>#<step のテキスト>`)と `testCaseId`(`fullName` のハッシュ)は、公式の cucumberjs 用 Allure adapter と同じ方法で計算されます。
  `historyId` は意図的にそうなっていません。
  そのため、Allure の history、trend、そして run をまたいだ flaky 検出は、ここでは機能しません。**
  これらはすべて、`historyId` が run をまたいで一致することを鍵にしています。
  そして step には、そこに合わせられる安定したものが何もありません。
  scenario と違い、step は record のどこにも自分自身の id を持っていないからです。
  それでも identity を計算する方法が 4 通り試されましたが、どれも別々の 2 つの step を同じものであるかのように誤接続します。
  step のテキストはそれ自身と衝突します(2 つの step がまったく同じ文言を持つことがあります)。
  位置(index、行番号)は、feature ファイルのそれより前のどこかが編集されるたびにずれます。
  出現回数を数える方法は、挿入された重複を元のものと区別できません。
  行番号ベースの方式は、この失敗のしかたを具体的に見せてくれたものでした。
  feature ファイルの冒頭にコメント行を 1 行足しただけで、すべての step が隣の step の history を静かに乗っ取り、それが起きたという手がかりは出力のどこにもありませんでした。
  警告もなく、件数のずれもなく、読み手が気づけるものは何もありませんでした。
  誤った接続は接続が無いことより悪く、試したすべての方式が誤った接続を生む以上、最後まで嘘をつかずに済む選択は 1 つだけです。
  run をまたいで何もつなげない、という選択です。
  そのため、すべての `historyId` は上で述べた 3 つの hidden parameter(`nukadoko.run`/`nukadoko.scenario`/`nukadoko.step`)を運びます。
  これらは run のたびに値が変わり、すべての `historyId` を意図的に引き離します。
  `excluded: true` ではなく `mode: "hidden"` にしているのにも理由があります。
  Allure は `excluded` な parameter をハッシュの計算前に落としてしまい、それでは意図そのものが無効になってしまうからです。
  `hidden` は parameter を UI から外すだけです。
  既存のスイートを nukadoko に移行するチームは、そのスイートの Allure history、trend、retry tracking をそのまま保つことはできません。
  これは実装の漏れではなく選択です。
  compat door は入るためのものであり、留まるためのものではありません。
  移ってきてもなお cucumber 形の、昨日の run に紐づいたレポートのままなら、そのスイートは移った意味を得ていません。
  時間をまたいだ観察には、代わりにここに居場所があります。
  それはこのコードベースには存在しない identity に依存しない居場所です。
  `nuka tend` の sign-off rot の findings と `post-navigation-read` の note です(「Tending」を参照)。
  どちらも、report の一連の記録が step の identity を信頼できるという前提を必要とせず、実際に accept されたものから読み取ります。
- ad-hoc な `do` の receipt は作業記録であり、test result ではないため、ダッシュボードには現れません。
  探索が証明することは、scenario を修復するか新しく書くことで表現され、その scenario の実行こそが Allure に表示されるものです。
- 1 回の run を見ることは Allure の仕事であり、nukadoko 自身に web UI はありません。
  history、trend、flakiness も Allure の機能ですが、上の identity の項目のとおり、この emitter はそれらを run をまたいでは供給しません。
  1 回の `nuka run` の呼び出しについて Allure が示すものはそれ自体で完結しており、後の呼び出しの step が今回の呼び出しに紐づくことは何もありません。

まだ実装されていないもの: フック自身の duration(record.json は今のところ hook ごとの timestamp を持たないため、フックの開始と終了はどちらも scenario 自身の境界に潰れます)、BeforeAll/AfterAll(emitter がそこから map できる run レベルの record が存在しません)、そして link-template の設定(`@issue:123` のような tag を URL に対応付けるもの)です。

要点はフォーマットの派閥争いではありません: 従来の cucumber の実行が Allure レポートを満たすのは、glue の作者が手で evidence を添付した箇所だけです。
一方で nukadoko の harness はどのみちすべてを計測しており、Allure 自身のモデル(attachment、label、parameter)には、その全部の一級の置き場所が既にありました。
Allure emitter は、nukadoko の計測の余剰が自動で、しかも今日既に見えるようになる場所です。
下にある messages emitter は 2 つ目の、より狭い出力であり、その役割は計測の余剰ではなく compat の忠実さです。

## Messages emitter

`nuka run` は呼び出しごとに 1 つの cucumber messages ストリーム(NDJSON、`@cucumber/messages` 経由で 1 行 1 envelope)を書き込み、デフォルトの出力先は `.nukadoko/messages.ndjson` です。
`nukadoko.config.ts` の `messages.output` で、root からの相対パスであれば他の任意の場所に移せます。
`enabled` フラグも CLI フラグもありません(Allure と同じです)。
emitter は常に実行され、スキップされるのは `nuka run` の呼び出しが 0 件の pickle を選んだときだけです。

- 1 回の run は 1 つのストリームであり 1 つのファイルです。
  `begin` は追記ではなく truncate します。
  追記だと 1 つのファイルに `testRunStarted` の envelope が 2 つ残ってしまい、読み戻せる単一の well-formed なストリームでなくなるからです。
  `nuka run` は呼び出しごとに 1 つの feature を実行するため、続けて 2 つ目の feature を実行すると最初のストリームは上書きされます。
  これは「1 ファイル、truncate」という設計の意図した帰結であり、見落としではありません。
- この emitter の役割は Allure emitter の逆です。
  Allure は nukadoko の計測の余剰が見えるようになる場所であり、こちらは compat の忠実さそのものです。
  唯一の仕事は、移行したスイートの既存フォーマッタと JUnit ベースの CI が、nukadoko が生成した run を従来の cucumber-js の run と同じように読み続けられることです。
- receipt の内部情報はストリームに一切出ません。
  バリデーション済みの result も、`mutates` も、`observed` の件数も、`error.kind` もです。
  `TestStepResult` と `TestStepFinished` は closed schema(`additionalProperties: false`)であり、そのどれにもフィールドがなく、Allure 自身の `[nukadoko.failure=<kind>]` label のような marker を通じてこっそり忍び込ませることもできません。
- Attachment は step が自分自身について宣言したものに限られます: `declared` の attachment とログの行で、後者は cucumber-js 自身の `text/x.cucumber.log+plain` という media type(`this.log()` が生成するもの)に乗ります。
  trace、スクリーンショット、HTTP log、バリデーション済みの result は Allure だけに留まります。
  その計測の余剰にはすでに置き場所があり、ここで trace を base64 で埋め込んでも、それを望む消費者がいないままストリームを太らせるだけだからです。
- `testRunFinished.success` は常に run 自身の exit code と一致します。
  BeforeAll/AfterAll はこのストリームに書き込む場所を持ちません(emitter が汲み取れる run スコープの record が存在しないからです)。
  そのため run スコープのフックが失敗した run は、どの scenario の中にも現れず、ここにしか現れません。
- 構造的に自己無矛盾であるだけでなく、実際の消費者に対しても確認済みです。
  自前の `messages.ndjson` を `@cucumber/junit-xml-formatter@0.14.0`(envelope ストリームの上で `@cucumber/query` を駆動するもの)に通してもエラーは投げられず、解決が必要なすべての id(pickle から testCase、testStepFinished へ、そして `pickleStepId` から gherkin の step へ)は解決できます。
  失敗した scenario の `<failure>` は step 自身のエラーメッセージを運び、`<system-out>` は step ごとの passed/failed/skipped の trace を運び、`<testsuite tests="...">` は実際の scenario 数と一致します。
  `<failure>` 自体には `type` も `message` の属性も付きません。
  `TestStepResult.exception` が決してセットされないからです(後述)。
  この確認ができているのは junit-xml の経路だけです。
  公式の HTML レポートやサードパーティの formatter はまだこのストリームに対して試されていません。
  確認できているのは、これが実際の消費者がエラーなく読める well-formed な cucumber messages ストリームであるということであり、既存のあらゆる formatter がこれをレンダリングできるということではありません。

正直な限界も、隠さずに書いておきます。
フックは 1 つの汎用 Before と 1 つの汎用 After に潰れます。
scenario record にはどの個別の登録が実行されたかの記録が無いからです。
フック自身の duration は常にゼロです。
これは Allure emitter が抱えるのと同じ限界です。
`declared` の label、link、parameter はプロトコルの closed schema に入れる場所が無く、落とされます。
`stepDefinition` の envelope は出力されません。
record は step 自身の定義の位置情報を保持しておらず、それでも出力すればでっち上げの事実になってしまうからです。
そして `TestStepResult.exception` は決してセットされません。
プロトコルが `Exception.type` を要求する一方、receipt が運ぶのは常にメッセージだけだからです。
これが、失敗した step の JUnit `<failure>` が body だけになる理由です。

## Self-healing(監査付き)

スクリプト化された scenario が壊れたとき(アプリが変わり、pattern が現実にマッチしなくなったとき)、修復のループはこうなります:

1. agent は `nuka do` を使い、1 step ずつ各 receipt を読んで次の呼び出しを決めながら、目標を適応的に再実行します。
2. receipt は実際にうまくいったこと(スクリプト化された scenario から逸脱した手順)を記録します。
   それらは物語であり、証明ではありません。
   agent は修復の物語として、それらを PR の中で引用してもよいです。
3. PR は型付き step や feature ファイルを更新します。
   その証明は、修復された scenario が green で通ること(scenario record とその receipt であり、他の変更と同じようにレビューされます)です。
   証明は常に scenario を通り、ad-hoc な一連の呼び出しを通ることは決してありません。

nukadoko の貢献は、すべての段階が記録を残すことです。
執筆は agent のワークフロー(同梱の skill)であり、エンジンの魔法ではありません。
監査証跡のない self-healing は、テストスイートが気づかないうちに何もテストしなくなる仕組みそのものです。
逸脱の記録こそが要点です。

## Tending(手入れ)

`nuka check` が答える問いは一つだけです: このプロジェクトは今すぐ run できるか。
プロジェクトは毎回それを通過していながら、それでも腐っていることがあります。
sign-off は、自分が凍結したコードを言い表さなくなることがあります。
宣言は、何にも行使されないまま何年も放置されることがあります。
契約は、それを選ばなければならない agent にとって読めないものになっていることがあります。
そのどれも run を止めはしませんが、そのどれもが放置されるほど高くつきます。
これがこのツールの名前の由来になっている失敗のパターンです。
ぬか床は毎日手入れをすれば熟成し、放っておけば死にます。

`nuka tend` が答えるのはもう一つの問いです: この語彙と、それが生み出してきた記録は、いまも健全か。

これが `check` への警告の追加ではなく別のコマンドである理由は、この 2 つが異なる瞬間に読まれ、異なる意味を持つからです。
`check` はあらゆる run の前に、CI の中で、agent のループの中で実行され、それが出力する行はどれもプロジェクトと green な run との間に立ちはだかるものです。
だからこそ、そこでの所見は立ち止まる価値があるものでなければなりません。
`tend` の所見はそうではありません: ここにあるものはどれも今日直さなければならないものではなく、もしそれらが毎回の `check` に現れたなら、本当に直すべきだった行までみんなが読み飛ばすことを覚えてしまうでしょう。
チェックが読む価値のあるものだという主張を中心に据えたツールにとって、ノイズは見た目だけの問題ではありません。

所見を挙げる前に、`tend` はぬか床がいまどこにあるかを述べる 3 行のサマリーを出力します。
この 3 行のどれも所見ではなく、exit code にも影響しません(移行の途中にあるスイートはそれ自体が異常な状態ではなく通常の状態であり、毎回それについて警告すれば、本当に対応が必要な所見を埋もれさせてしまうでしょう):

- `scanned:` は、この run が実際に見たすべてのディレクトリを名指しします。
  `featuresDir` と、各 `additionalFeatureDirs` エントリです(「Session、environment、secret」を参照)。
  最初に出力されるのは、件数は何について数えられたかを読み手が知るまで何も意味しないからです。
- `bed:` は、語彙のうちどれだけが、いまも compat のままではなく型付けされているかを示します。
  加えて、型付き step のうちいくつが `mutates: false`(読み取り専用)を宣言しているかも示します。
- `declared:` は、型付き step が宣言できることのうち、実際にどれだけが宣言されているか(`rationale`、各スキーマフィールドの `.describe()`)を示します。

これが存在する理由は、その情報がすでにそこにありながら誰にも読まれていなかったからです。
receipt の `world` と `declared` の件数は、スイートが昇格するにつれて確かに縮みますが、それは人が進捗を見て取る手段としては真実であっても無意味です: 誰も、自分がどこまで進んだかを割り出すために receipt のディレクトリを読んだりはしないからです。
それを一度だけ、ぬか床の健全さそのものを主題とするコマンドの中で述べること、それが、誰もが実際に目にするものにしている当のものです。

`tend` が見るもの、そしてそれぞれがなぜスタイルの問題ではなく腐敗なのか:

- **もはや自分が凍結したコードと一致しない sign-off。** 記録は、自分が受け入れた feature のソースと、その run のすべての receipt を運びます。
  凍結された `result` がその step の現在の `returns` スキーマをもはや通らない場合、あるいは凍結された feature のソースがそれを取った元のファイルともはや一致しない場合、あるいはそれが引用する step が語彙から消えている場合、その記録はディスク上に残ったまま、もはや裏付けられない主張をし続けていることになります。
  これはここでの所見の中で唯一、注記ではなくエラーになるものです: 自分が述べている内容を静かに言い表さなくなった sign-off は、sign-off が無い状態よりも悪いです、なぜならそれはまだ数に入れられ続けているからです。
- **config からずれた、sign-off 自身が記録している条件。** sign-off は条件(「Sign-off」を参照)、すなわち `(environment, browser)` にスコープされており、どちらも計測値であって宣言ではありません。
  ある feature の直近の sign-off が、プロジェクトの config がもはや宣言していない browser を記録している場合、その sign-off について今この瞬間に何か間違っているわけではありません。
  だからこそ、上の所見とは違い、これはエラーではなく注記です。
  この注記ができる前に accept された記録には、そもそも比較すべき条件が記録されていないため、この所見の対象から完全に外れます(推測はしません)。
- **import に失敗した step ファイル。** `tend` は `nuka check` と同じ寛容なやり方で step を発見します(「報告は寛容に、実行は速く失敗する」を参照)。
  壊れた glue ファイルは run を止める代わりにスキップされるので、それが本来もたらしていたはずのものは、ここでのあらゆる件数と所見から静かに欠落します。
  何も失敗していないから欠落しているのではありません。
  run 全体で 1 件の note であり、ファイルごとの 1 件ではありません: 壊れたファイル自身の原因は `nuka check` 自身の所見(`step-file-import-failed`)であり、これはただ、何件の step が見えなかったかと、そのファイル名だけを述べ、exit code には触れません。
- **何にも行使されない `from` 宣言。** その step があらゆる feature 内で出現するたびに、そのキーは行から直接キャプチャされており、宣言された生産者が何かを供給することは一度もありません。
  それはただの事実として報告されるのであって(その宣言は `nuka do --use` を通じてなお到達可能です)、削除すべきだという断定としてではありません。
- **どの feature からも束ねられていない pattern を持つ step。** CLI 専用のつもりの step は pattern を一切持つべきではなく、pattern を持っているなら、それは自分が占めていない scenario 上の場所を主張していることになります。
- **`.describe()` を持たないスキーマフィールド。** これは agent にまっすぐ狙いを定めた `tend` の所見です: agent がフィールドの意味を知る手段は `nuka describe` であり、description のないフィールドは、名前がすでに伝えていた以上のことを何も agent に伝えません。
  step ファイルを読む人間なら周囲のコードを見られますが、2 つの step のどちらかを選ぶ agent にはそれができません。
- **`rationale` を持たない step。** `description` はその step が何をするかを述べており、それはその step を呼ぶには十分です。
  `rationale` はなぜこのように作られているのか、何が却下されたのかを述べており、それは agent がその step を書き換えてよいと決める前に必要とする情報です。
  それが欠けていれば、あらゆる書き換えは根拠を欠いたまま行われます。
- **どの pattern からも使われていない設定済みの parameter type。** 使われていない設定であり、他のものと同様に報告されます。
- **support コード側にまだ登録されたままの `defineParameterType`。** それは動き続けており、`config.parameterTypes` がその typed 時代の住まいであって、登録をそちらへ移してもマッチは何も変わりません。
  これはかつて `nuka check` の warning でしたが、それは分類の誤りでした: スイートに compat が少しでも残っている限り現れ続けるものであり、それは正常な状態であって、毎回の run の前にそれを出力すれば、人々に本当に run を止める行を読み飛ばすことを覚えさせてしまいます。
- **`secrets.public` または `secrets.redact` のエントリが、どの envFile も定義していないキーを名指ししているもの。** 何にも届いていない、実在する指示です: 自分が記述している対象のファイルから設定がずれてしまっているということです。
  これも同じ理由で `check` から移されました: この run を実行すべきかどうかは、これによって何も変わらないからです。
  その隣にある所見は `check` に残っており、対比する価値があります: 値が短すぎて redact されない `redact` エントリと、secret らしく見えるキーを持つ追跡済みの env file は、どちらも run が始まった瞬間に平文がログに届くことを意味し、それはまさに事前に知っておくべきことだからです。
- **設定された `additionalFeatureDirs` エントリがディスク上に存在しないもの。** それは `nuka check`/`nuka tend` が何をスキャンするかを広げるためだけに名指しされたものです。
  だからこそ、存在しないディレクトリは報告すべき config の誤りであり、それは `featuresDir` が欠けている場合とまったく同じです。
  ただし `tend` には `check` が持つような config の誤り専用のエラー枠がないため、ここでは注記になります。
  `nuka check` が同じ事実をエラーとして報告しているのとは対照的です。
- **`nuka check`/`nuka tend` がスキャンするどのディレクトリの外にもある、accept 済みの feature。** sign-off の記録はその feature が green で走ったことをすでに証明していますが、ここが一切歩かない feature は、それが結び付ける step を、このレポートの他のあらゆる所見に対して `pattern-unbound` のまま見せ続けます。
  sign-off の記録が読まれるのは、この所見の可視性のためだけです。
  何をスキャン対象にするかを決めるためではありません。
  スキャン対象をそこから広げてしまうと、少なくとも一度は accept されたことのある feature にしか気付けず、まだ書きかけの feature を静かに見逃してしまいます。
  それこそ、誤った `pattern-unbound` がいちばん人を誤解させる feature です。
  `additionalFeatureDirs` にそのディレクトリを名指しすることが、実際にこれを直す方法です。
- **step 自身の trace が、navigation の呼び出しのすぐ後ろに別の呼び出しが着地していることを示しているもの。** 凍結された sign-off の記録の receipt だけを読みます、live な run の receipt は読みません(`.nukadoko` は、ここでの他のすべての walk と同じやり方で、この walk からも除外されたままです)。
  その receipt 自身の `actions` にある `goto`・`reload`・`goBack`・`goForward` のそれぞれについて、その step が次に行った呼び出しまでの経過を見ます。
  同じ receipt 自身の `ctx.poll` の窓の中に着地する読みは除外されます: 「Context API」の doctrine がすでに求めているとおり `poll()` を使って書かれた step は、構造上すでにリトライしているのであって、この所見が見分けようとしている対象そのものではありません。
  報告されるのは経過そのものだけであり、判定ではありません: navigation の後にページが描画を終えるまでどれだけかかるかはこのツールには測りようがなく、どの Playwright の呼び出しが auto-wait でどれが一発勝負かを分類するテーブルも、それを推測するために作られてはいません、そのようなテーブルはこのツールが計測したものではなく依存先自身の意味論を書き写すことになり、その依存先が変わるたびに腐るからです。
  `actions` を一切持たない receipt、つまりそのフィールドが存在する前に書かれた記録が今も持っている形は、静かに対象外になります、エラーにはなりません。

この最後の所見こそ、上のリスト全体が `check` ではなく `tend` に置かれている理由をいちばん素直に示しています。
そこで名指しされる step はすでに green で run 済みであり、その receipt はすでにその合格を凍結しています。
今日それの何が壊れているわけでもなく、それによって止まる run もありません。
変わったのは、その合格がどのように起きたかについての事実をツールがいま見えるようになったことだけであり、その合格が本物でなくなったわけではありません。
`check` は run がいますぐ進めるかどうかに答えるために存在しており、すでに合格した step についてはもう言うことがありません。
`tend` はすでに合格したものがいまも健全かどうかに答えるために存在しており、「たまたま走っているレースにまだ負けていない」というのは、まさにその問いが扱う健全さの一種です。
これをエラーとして報告することは、まだ現れていない症状を、すでに現れたものとして扱うことになります。

所見は、他のすべてと同じく `--json` に対応します。
sign-off の所見は非ゼロの exit code で終了し、定期実行されるジョブがそれに反応できるようにする一方、残りの所見はそうしません、プロジェクトはそれらを抱えたままでいることが許されているからです。

`tend` は報告するだけで、修復はしません。
直すということは、description を書くこと、step を削除すること、feature を再び accept することを意味します: どれも背後に書き手がいる判断であり、これは `accept` が dirty な working tree を勝手に直さずに拒否するのと同じ理由です。

## CLI summary

npm パッケージは `nukadoko` で、それがインストールするただ 1 つのコマンドが `nuka` です。

```
nuka run <feature[:line]>     execute scenarios; receipts + allure-results.
                              :line runs one scenario, for iteration only — a
                              partial run can never be accepted. stderr gets
                              per-step/per-scenario progress as it runs, then
                              every location this run wrote and a summary
                              line; --quiet drops the progress lines only.
                              stdout stays NDJSON, one record per scenario,
                              always
nuka do <step> [--args '<json>'] [--use <receipt-id>]
                              execute one typed step; receipt to stdout.
                              --args is required unless --use supplies
                              every key; --use fills its `from` keys
                              from an earlier execution's result
nuka steps [--json]           list the whole vocabulary, typed and compat:
                              name, patterns, description, mutates, which
                              fixtures each step needs (needs, needs_browser,
                              or needs: null plus needs_error for the one it
                              can't read), and where each chained args key
                              comes from; --json's top level is { steps,
                              import_failures }, the second always present,
                              exiting 1 if either has anything in it, output
                              printed either way
nuka describe <step>          full contract, schemas as JSON Schema, plus
                              rationale when the step declared one, plus
                              import_failures beside it (same shape as nuka
                              steps' own); exits 1 when that array is non-empty
nuka scaffold <name>          typed step template that fails until implemented
nuka check [feature]          static checks: pattern/schema mismatches, Then
                              binding to mutating steps, undefined steps per
                              feature, ambiguous steps (one line two patterns
                              both match), duplicate patterns, a required
                              args key nothing on that line could fill, a
                              required `from` key whose producer is absent,
                              bound later in the scenario, or ambiguous
                              between two producers, a `from` naming a step
                              discovery never registered, a fixture
                              dependency cycle, a process-scope fixture
                              depending on a scenario-scope one, a page
                              override that owns neither page nor context,
                              config coherence, unreadable step files
                              (reported, not fatal, the rest of the project
                              is still checked), a `.cjs` file discovery
                              walks but never imports, a featuresDir scan
                              that found nothing loadable, unsupported hook
                              tag expressions; with no argument, scans
                              featuresDir plus additionalFeatureDirs; a
                              feature argument checks that one file instead,
                              for a feature living outside both
nuka accept <feature>         freeze that feature's last green run as a
                              committed acceptance record beside it
nuka tend [--json]            scans featuresDir plus additionalFeatureDirs,
                              then where the bed is, then what is rotting
                              rather than what is broken: how much of the
                              vocabulary is typed rather than compat, how
                              many typed steps are read-only, and how much
                              of it declares what it could, then a sign-off
                              that no longer matches the code it froze (the
                              one finding that exits non-zero), a step file
                              that failed to import, a `from` nothing
                              exercises, a patterned step no
                              feature binds, a schema field with no
                              `.describe()`, a step with no `rationale`, a
                              configured parameter type no pattern uses, a
                              `defineParameterType` still registered from
                              support code, a secrets entry naming a key no
                              envFile defines, a configured
                              additionalFeatureDirs entry absent from disk,
                              an accepted feature outside every scanned
                              directory, a fixture no typed step requires,
                              a fixture reaching page/context
nuka session list|clear
nuka init [--base-url <url>] [--features-dir <dir>]
                              set up a project; ends with a self-check
nuka skill path               where the bundled skill lives, for a project
                              that wants the copy matching this nukadoko
```

テキスト出力(`--json` なし)は、端末で読む人間向けに整形されます。
`--json` が機械可読な契約です。

### 報告は寛容に、実行は速く失敗する

壊れた step ファイルへの反応は、この一覧の中で 2 通りに分かれます。
その分かれ目は 1 つの問いです: そのコマンドはこれから step を実行しようとしているのか、それとも語彙を報告するだけなのか。
`nuka steps`、`nuka describe`、`nuka check`、`nuka tend` は報告する道具です: それぞれがファイル単位で step を発見するため、import に失敗した 1 ファイルが、プロジェクトの残り全体がまだ見せられるはずのものまで空にしてしまうことはありません。
`nuka check` はその失敗を `step-file-import-failed` として名指しし、`nuka steps`/`nuka describe` は同じ事実を(前述の)`import_failures` として運び、`nuka tend` は読めなかったファイルの周りで静かに数を減らす代わりに `import-failures-unseen` という 1 件だけの note を足します(「Tending(手入れ)」を参照)。
`nuka run`、`nuka do`、`nuka init` はこれから step を実行しよう、あるいはこれから実行するプロジェクトを立ち上げようとしている道具なので、fail-fast のままです: 同じ壊れたファイルは呼び出し全体をそのまま拒否します、報告するだけの場合と違い、その先へ進むことはこれから実行しようとしている何かにとって危険だからです。
移行中のスイートにとって、glue の一部がまだ壊れているのは通常の状態であり、その状態でまったく動かなくなる報告の道具は、移行のダッシュボードとして役に立ちません。
そのまま押し進んでしまう実行の道具は、実際には一度も読めていない glue に対して実行することになります。

## Out of scope(正直な限界)

- step の実装の意味的な真偽は PR レビューに委ねられます。
  ツールが保証するのは入出力の形と、実行された事実だけです。
- nukadoko は、shell アクセスを持つ agent が `.env` を直接読むことを止められません。
  nukadoko がなくすのは、secret が agent の context を通過する構造的な必要性です。
- sign-off は、ソフトウェアが正しいことの証明ではありません。
  それは、合意された scenario が名指しされた 1 つの commit で green だったことを記録するものであり、今日について何も語りません。
  それは、同じ commit が今なら green になるだろうということさえ主張しません。
  run が行われたタイミングに依存する欠陥(あるタイムゾーンで計算され別のタイムゾーンで読まれる日付、時計がまたぐ境界)は、それが run から欠けていたのとまったく同じように記録からも欠けており、nukadoko はそれを確かめるために凍結された scenario を再実行することはありません。
  正直さとは、記録が語るのは常にただ 1 回の実行についてだけだということであり、限界とは、欠陥のまるごと 1 つのクラスがどの 1 回の実行からも見えないということです。
- **step を `defineStep` に昇格させることは一方通行です。** compat の扉が約束するのは compat の資産についてだけです: import を元に戻せば、ただの cucumber-js スイートが残ります。
  `defineStep` には、切り替えて戻す import がありません。
  昇格させた step の body は移ります(`run` は Playwright 自身のオブジェクトに対して書かれており、それは下で述べているのと同じ選択によるものです)。
  けれどもそのスキーマ、receipt の `result`、`from` とそれを読む束縛順序のチェック、そしてそれらの上に組まれたあらゆる契約チェックは移らず、ここには元に戻す手段は何もありません。
  埋めるべき欠落としてではなく、限界として述べます: 変換は step ごとの機械的な作業であり、import の可逆性があるのは採用の最初の一歩を安くするためであって、型付き側を選択制にするためではありません。
- **意図的に driver-agnostic ではない。** `page` と `request` の fixture は Playwright 自身の `Page` と `APIRequestContext` を返し、compat の扉は移行中の glue に、それがすでに使っていたのと同じオブジェクトを渡します。
  それらを nukadoko 自身のインターフェースの背後にラップすれば、そのラッパーが公開し忘れたあらゆる能力を犠牲にし、ユーザーがすでに知っている語彙を、このツールだけが話す語彙に置き換えることになります。
  それは公式の SDK を通して書くことの正反対です。
  引き換えに、別の driver へ後から差し替えるときは public API と compat の扉が同時に壊れます。
  これは見落としではなく、承知のうえで受け入れています。
  step の本体をある driver の API から別の API へ書き換えることは、agent が得意とする作業です。
  portability のために先にコストを払うことは、driver の差し替えでないあらゆる変更を遅くしてしまいます。
  見直すのは、その差し替えの確率が上昇したと計測されたときであり、それより前ではありません。
- テストの並列実行、sharding、CI レポーティングはありません。
  前の試行の記録を消す retry もありません。
  nukadoko 自身による outbound のネットワーク I/O もありません。
  HTML のレンダリングもありません。
  それは Allure の仕事です。

## ロードマップ

- **M1(engine core)**: `defineStep`、`do`、pickle に対する `run`、receipt、session/environment、`check`、`init`。
  secret のオンボーディングは再設計されました。
- **M2(compat API)**: `nukadoko/compat`(Given/When/Then/World/hooks のサブセット)、cucumber-js + Playwright のスイート向け移行ガイド。
- **M3(reporting interop)**: scenario 実行のための cucumber messages(NDJSON)エミッタ(移行チームの既存 formatter、JUnit ベースの CI、HTML レポートを動き続けさせる互換面)と、旗艦ダッシュボードとしての allure-results エミッタ。
- **M4(sign-off)**: `nuka accept`、それが拒否の根拠にする commit と working tree のクリーンさのチェック、そして feature の隣に書かれる凍結された記録です。
- **M5(skills)**: nukadoko が同梱する skill と、`nuka skill path` です。
  CLI は意図的に小さな動詞の集まりです。
  skill は、それらを agent が指示なしに従えるワークフローに変えるものであり、そのどれもエンジンを変えません。
  skill は Agent Skills specification に従うため、`gh skill install` と Claude Code の plugin marketplace の両方が複数ホストへの配布を担います。
  nukadoko 自身はどのホストのディレクトリにもファイルをコピーしません。
  `nuka skill path` が残るのは、その 2 つには出せないものを答えるためです(インストール済みの nukadoko と同じバージョンの skill の在り処)。
  skill は CLI を説明したものなので、両者のバージョンがずれると記述が虚構になります。
  2 つとも出荷済みです。
  **acceptance skill** は受け入れループを最初から最後まで動かします(基準を入力に、`steps` と `describe` で語彙を読み、欠けている操作を scaffold して実装し、scenario を書き、そして green になるまで `run` して `accept` する)。
  **migration skill** は compat の監査が計測したことを運びます(実際の cucumber-js のスイートが実際にぶつかる gap を、ドキュメントの順序ではなくつまずく順序で)。
  その最初の段階は `nuka check` がそれらの gap を報告することに依存しており、`nuka check` は今それを行っています(「Compat steps」を参照)。
  どちらの skill も、CLI がすでに答えられる事実(語彙、契約、拒否の根拠)を書き写しません。
  それらを書き写した skill は、コマンドが変わった瞬間から嘘をつき始めるからです。
- **M6(chained arguments)**: `from`、`nuka check` と `nuka run` が共有する scenario 順序チェック、`do` の `--use`、そして引用する receipt の隣に step 名を記す `used` のエントリです。
  step の入力がどこから来るかは、`run` の本体の中の散文であることをやめ、ツールが読む宣言になります(「step の連鎖」を参照)。
- **M7(tending)**: `nuka tend`、壊れることではなく腐ることについての所見です(「Tending(手入れ)」を参照)。
  意図的に `nuka check` には含めていません: `check` はあらゆる run の前に読まれるものであり、立ち止まる価値があり続けなければならないからです。
- **M8(fixtures)**: `nukadoko.config.ts` 自身の `fixtures` の下に宣言するユーザー定義の資源です(「Fixtures」を参照)。
  完全な型付けのための `defineFixtures`、scope、step や scenario 自身の成否を運ぶ `use()` ベースの teardown、fixture ごとのタイムアウト、そしてそれらに付随する `check`/`tend` の所見です。
  typed 側にあった、compat の After hook にはなかった 1 つの gap を塞ぎます。
  受け入れ条件そのものではない片付けを置く場所です。
- **Later**: AI 支援の glue コンバータ(既存の正規表現ベースの glue → 型付き step)、scenario の harvesting(記録された `do` の一連の呼び出しから feature ファイルを生成する)、tag-expression によるフィルタリング、移行ではなくその場での共存が必要な実際のスイートのための cucumber-js アダプタ。

## 実装ノート

- ランタイム依存: `@cucumber/gherkin`、`@cucumber/cucumber-expressions`、`@cucumber/messages`、`allure-js-commons`、`playwright`、`zod`、`tsx`(実行時の TS インポート)、`yargs`(CLI)。
  Node は 20 以上。
- 形式やプロトコルに公式の SDK があるときは、nukadoko は形式を再実装せず、その SDK を通して書きます(allure-results は allure-js-commons の reporter 機構を、cucumber messages は `@cucumber/messages` を通して)。
  nukadoko 自身はその上の薄い写像層に留まります。
  公式機構の一部を上書きするのは、具体的な必要が現れたときに行う計測された判断であって、既定の選択ではありません。
- id の形式: `<kind>-<timestamp>-<short random>`。
- `nuka steps` と `nuka describe` は step モジュールをインポートします(compat の登録と pattern を集めるにはそれが必要だからです)。
  インポートはファイルのトップレベルのコードを実行するため、実行時と同じ注意が必要です。
  Shell の補完は決してインポートしません。
  型付き step の名前はファイル名から、id と session の名前は state directory から補完されるため、語彙の量にかかわらず TAB は高速なままです。
- 最初の実世界での検証ゲート(M2 が詳細に設計される前)。
  約 10 個の実際の feature ファイルを結び付け、AI が下書きした型付き step をレビューすることが、手で glue を書くことより実際に優れているかを測ります。
  公開されている 7 プロジェクトの 11 個の feature ファイルに対して実行し、答えは 7 プロジェクト中 6 つで yes でした。
  第二のゲートは typed の方ではなく compat の扉を測るもので、上の Compat steps の節で報告しています。
