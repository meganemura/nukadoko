# nukadoko 仕様

> nukadoko(あなたの Gherkin のための生きたぬか床): 型付きの step、receipt、そして agent-first な CLI。

> 原文は spec.md。相違があれば原文が正。

Status: M1(engine core)実装済み(`steps`/`describe`/`do`/`run`/`check`/`init`/`scaffold`、session、environment、secret)。
M2(compat、後述)も実装済み(`nukadoko/compat`、typed World の計測、移行ガイド)。
実世界での検証ゲートは、いまや両方とも実行済みです。
typed step を実際の feature ファイルに対して起草したゲートと、compat の扉を実際の cucumber-js の glue に対して監査したゲートです(後述)。
Pre-0.1 で、M3 以降のうち Allure emitter と messages emitter はどちらも実装済みであり、sign-off(`nuka accept`)と M5 の両方の skill も実装済みです。
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
  この対応関係は静的にチェックできます(`nuka check`)。
- step に付いた data table や docstring は、名前付きキャプチャが消費せずに残した唯一の必須 args キーに結び付きます(table は `string[][]` として、docstring は `string` として)。
  他のものと同様にスキーマでバリデーションされます。
  Gherkin の table が初めて型を持つことになります。
  attachment が存在するのに未消費の必須キーが 0 個または複数ある場合は `check`/`run` のエラーになります。
  予約されたキー名はありません。
- `from` は、pattern がキャプチャしなかった args キーの値がどこから来るかを宣言します。
  `from: { projectId: [createProject, "id"] }` は「`projectId` は、この scenario 内で以前 `createProject` が返した結果の `id` である」という意味になります。
  executor は args のバリデーションより前にこのキーを埋めるので、キーは required のままにでき、スキーマはその step が実際に何を求めているかを言い続けられます。
  値になれるのはキー名だけで、決して変換ではありません。
  なぜその制限こそが要点なのか、そしてキー名だけでは足りないときにどうすればよいかは「step の連鎖」を参照してください。
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
- `run` の本体は、渡された context の上で自由に書ける TypeScript です。
  合成とは、別の step モジュールをインポートし、同じ ctx でその `run` を呼び出すことです。
  共有ヘルパーは通常のモジュール(例: `features/steps/lib/`)に置きます。
- 意味的な正しさ(実装が description と pattern の主張どおりに動くかどうか)は、ツールではなく PR レビューによって保証されます。
  `steps/` は CODEOWNERS で保護してください。

### Context API

`run(ctx, args)` に渡される `ctx` は、executor が注入しなければ存在し得ないもの(ツールが所有する状態と、計測された連鎖)だけを運び、それ以外は何も運びません。
純粋なヘルパーは context のメンバーではなく import です。
この 1 つの規則が、今後のあらゆる「これは ctx に置くべきか」という問いを決めます。

- `await ctx.page()`(Playwright の Page。初回呼び出しでブラウザが起動し、session の storageState から復元され、設定された baseURL が browser context に配線されるため `page.goto("/path")` はそれを基準に解決されます)
- `await ctx.request()`(session の cookie を持つ Playwright の APIRequestContext)。
  baseURL はここでは任意です。上の `ctx.page()` と同じです。
  複数のホストへ絶対 URL だけで話すスイートには述べるべき単一の baseURL がなく、nukadoko はこの呼び出しのためだけに意味のない baseURL を config に書かせません。
  baseURL が未設定のまま step が相対パスを渡した場合、その失敗は Playwright 自身のものです。
  nukadoko はそれを先回りして防ぐために URL 解決規則を自前で実装しません。
- `ctx.env`(設定された envFiles から得られる環境変数、読み取り専用)。
  これは便利機能ではなく、決定論(プロセス環境は決してマージされない)と secrets の赤塗り(redact できるのは nukadoko 自身がロードした値だけ)が強制される場所です。
- `ctx.requireEnv(name)` は `ctx.env[name]` と同じ値を返しますが、必須の変数を読む step がそれぞれ自前で書く羽目になっていた存在チェックを肩代わりします。
  `undefined` を返すことは決してなく、代わりに投げることで常に `string` を返します。
  空文字列も欠落として扱われます。
  envFile の `KEY=` という行は「キーが省略された」ではなく `""` にパースされ、その変数を必須と宣言した step にとってはどちらの場合も等しく壊れているからです。
  エラーはキー名だけを名指しし、値は決して含みません。
  欠落した値には示すべき値がなく、値を一切運ばない形は後になって redaction の抜け穴にもなり得ません。
  そしてどの envFile を直せばよいかは言えません。
  `ctx` が見るのは常にマージ済みの結果だけで、`config.envFiles` のリストを見ることは決してないからです。
  すべてのキーを一度に欲しい稀な step のために `ctx.env` は残ります。
  `requireEnv` に渡した名前は、その呼び出しが値を見つけた場合も投げた場合も、読み取った順に重複なく receipt の `required_env`(「Receipt」を参照)に記録されます。
  同じ値を `ctx.env` から直接読んだ場合はそこには残りません。
  そちらはプレーンなオブジェクトであり、ライブラリはそこに一切関与しないからです。
- `ctx.baseURL`(設定された baseURL。自分で URL を組み立てる、まれな場合のためのものです。よくある経路には上記のとおり配線済みです)
  `config.baseURL` が未設定のときは `undefined` になります。
  絶対 URL だけのスイートにとってそれは正当な状態であり、エラー状態ではありません。
- `ctx.resultOf(stepModule)` は、現在の scenario 内でその step が直近で成功した実行の、バリデーション済みの result です。
  `nuka do` の下では、あるいはその step がまだ成功していない場合は `undefined` になります。
  これは scenario 経路のデータチャネルであり、意図的に World ではありません。
  そこには何も書き込めず、読み取れるのは `returns` のスキーマを通過した結果だけで、依存関係は他の step モジュールへの目に見える `import` になります(その step 自身のスキーマによって型付けられ、diff の中でレビューできます)。
  「その listing は閉じている」のような feature の一文は、その参照先がバリデーション済みの結果を生成した範囲でのみ実装できます。
  `from`(「step の連鎖」を参照)は同じ読み取りを宣言的な形にしたものであり、まず手を伸ばすべきはそちらです。
  `resultOf` に残るのは、キー名では表せない読み取りです。
  discovery が登録しなかった `Step` を渡すと、`undefined` を返す代わりに投げます。
  その規則がどんな間違いを捕まえるためのものかは「step の連鎖」を参照してください。
- `ctx.section(label: string): void` は、実行がその名前の段階に到達したことを記録します。
  同期的で、返り値はなく、対になる「終了」呼び出しもありません。
  呼び出しはすべて、呼ばれた順で receipt の `sections`(「Receipt」を参照)に追加され、一度も呼ばない step には `sections` キー自体が現れません。
  これは `used` と同じ慣習です。
  区間を囲む形の関数(`ctx.section(label, fn)`)ではなく裸のマーカーにしてあるのは意図的です。
  区間を囲む形にすると、入れ子や早期 `return`、その境界をまたぐ `await` が何を意味するかをすべて決めなければならなくなりますが、それはこの API が答えようとする問い(実行がどこで止まったか。止まったブロックがどんな形をしているかではなく)には要りません。

`page()` と `request()` は、nukadoko 自身の型ではなく Playwright 自身の `Page` と `APIRequestContext` をそのまま返します。
これは代償を伴う選択であり、その代償ごと「Out of scope」に明記してあります。

ヘルパーは import として提供されます: `import { poll } from "nukadoko"` が非同期ジョブに対する submit-poll-fetch のループです。
これは executor が所有するものを何も必要としないため、`ctx` には置かれません。
`ctx.section` も一見そちら側に見えますが、そうではありません。
`ctx.section` が書き込むのは executor が所有し step の境界ごとにリセットするコレクタであり、`observed` や `used` がすでに持っているのと同じ寿命なので、この節自身の規則によって `ctx` に属します。
この境界の規則には以前のバージョンがあり、そこでは `ctx.section` を丸ごと保留していました。
progress log の機能が実行中の一区間に名前を付けて記録するようになるまでは、それは何もしないはずだという理由からです。
その理屈は「何もしない API を作らない」という点では正しかったものの、名前を付ける先が実際にはどこに必要だったのかを見誤っていました。
receipt こそがすでにその行き先であり、step 自身の実行がどの段階に達したかを言うのに、生きた log は一度も必要なかったのです。
必要だったのは、それをどこかに書き留めることだけでした。

### step の連鎖

CLI 専用の step(`pattern` を持たずに定義された step)に `pattern` を与えて scenario に束ねると、その step が単体では直面しなかった問いが立ち上がります。
以前の step が生成した値は、どうやってこの step まで届くのか、という問いです。
一見もっともらしい 2 つの答えは、どちらも何かを失います。
引数を捨てて `ctx.resultOf` だけで読むようにすると `nuka do` の単体実行を失います。
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
  async run(ctx, args) {
    // args.projectId is present or this line was never reached.
    const res = await (await ctx.request()).post(`/projects/${args.projectId}/archive`);
    return res.json();
  },
});
```

pattern の capture は今も優先されます。
`from` が補うのはこの step のこの出現がキャプチャしなかったキーだけなので、同じ step が、ある scenario では Gherkin の行から値を取り、別の scenario では以前の step から値を取ることができます。
そこで取られるのは、その以前の step がこの scenario 内で直近に成功した実行の結果です。
これは `ctx.resultOf` が持つのと同じ寿命です。
同じ chain だからです。
注入は args のバリデーションより前に起こります。
それこそが要点です。
キーは **required** のままであり、`args` は、呼び出し元の誰かがたまたまどう供給しているかではなく、その step が何を要求しているかを言い続けます。

なぜ selector 関数ではなくキー名なのか。
キー名はデータです。
`nuka steps --json` と `nuka describe` の中に「`projectId` ← `createProject.id`」として生き残り、それによって agent は一度も教わっていない順序を自分で組み立てられます。
`nuka check` が何かが実行される前に scenario を判断する際に読むのも、まさにこれです。
関数はより多くを表現しながらより少なくしか言えません。
ツールは、あるキーがどの step から来たかは報告できても、その step のどの部分から来たかは決して報告できないからです。
キーで参照できるくらい平らな形に `returns` を作ることは軽いコストであり、そのほうが step も結局は読みやすくなります。

`from` を宣言することは、確信を得るのに何も犠牲を払わないチェックを手に入れることです。
あらゆる scenario 内のその step のあらゆる出現について、`nuka check` は — そして `nuka run` も、その scenario を実行する前に — 宣言された各キーがその行でキャプチャされているかを尋ね、されていなければ、上流の step が同じ pickle 内でそれより前に現れているか(Background を含みます。pickle は自分の Background の step を運ぶからです)を尋ねます。
`nuka run` がこれを行うのは、check し忘れることがブラウザセッション 1 回分の代償で罰せられないようにするためです。
どちらもない **required** なキーはエラーです。
その run は確実に args のバリデーションに落ちるので、早い段階でそう言っても偽陽性を生みません。
どちらもない **optional** なキーは何も言いません。
スキーマがすでに値は無くてもよいと言っており、守られている契約について警告することは、ノイズが致命的な唯一の場所でノイズを出すだけだからです。
これは `from` を動機づけたケースを閉じます。
消費者を生産者より前に束ねる scenario は、実際のブラウザ時間で数分が費やされるまで、正しい scenario と見分けがつきませんでした。

`from` と `ctx.resultOf` はどちらも、上流の step を名前ではなく `Step` オブジェクトそのもので識別します。
そのため `await import()` を経由して届いた step は discovery が登録したものとは別のインスタンスに解決され、何にもマッチしません。
これはかつては無音でした。
`resultOf` はただずっと `undefined` を返し続けるだけでした。
今はもう無音ではありません。
登録されていない `Step` は、それが見つかった場所でエラーになります。
`from` は静的にそれを名指しするので `nuka check` がそれを報告し、`run`/`do` はその step の実行そのものを拒否します。
一方 `resultOf` は呼び出しの時点でしか捕まえられず、そこで投げます。
登録済みだがまだ実行されていない step は今も `undefined` を返します。
それは間違いではなく状態です。

`from` が表現できないものは `ctx.resultOf` に残ります。
途中で形を変える必要がある値、必要かどうかが実行時にしか決まらない読み取り、2 つの上流 step のどちらからでも来うるキー、あるいは result 全体をまるごと使う場合です。
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
そこで手放すのはそのヘルパー自身の receipt であり、それが行う HTTP は今も `observed` に数えられ、`ctx.section` も実行がどこまで進んだかを記録し続けられます。
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
  ツールが見たすべてのネットワーク呼び出しが対象であり(`ctx.request()` と page の両方を通じたもの)、GET/HEAD 以外の呼び出しはすべて観測された書き込みとして数えられ、`mutates`(宣言)の隣に置かれます。
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

## 実行

### Scenario(スクリプト化された経路)

```sh
nuka run features/checkout.feature[:12] [--env <name>] [--session <name>]
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
    "screenshots": ["final.png"],
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
  ブラウザが使われるときは Playwright の trace とスクリーンショット、`ctx.request()` の呼び出しはすべて http.jsonl に記録され、receipt 自体が一次記録になります。
- `observed` は、その実行に対してツール自身が見たネットワーク呼び出しを数えます(`ctx.request()` と page の両方を通じたもの)。
  GET/HEAD 以外はすべて書き込みとして数えられます。
  これは書き込みの意味論そのものではなく、HTTP メソッドをそのプロキシとして使っているため、一度も書き込んでいない step に POST ベースの読み取りが不利に働くことがあります(キーワードの意味論を参照してください)。
  この回数はそれ単独では何も決めません。
  Then の位置も読み取り専用の environment も、作用する対象は `mutates` の宣言であり、この回数では決してありません。
  `observed` は `mutates`(宣言)の隣に置かれているため、誤った宣言はここでも Allure のレポートでも反証可能です。
- `used`(空でないときだけ現れます)は、この実行が値を引き出した以前の実行の一覧です。
  `from` による注入、`ctx.resultOf` の呼び出し、あるいは `nuka do` での `--use` の receipt のいずれかを通じたものです。
  どの経路もライブラリのコードを通るため、読み取りは計測されるのであって宣言されるのではありません。
  各エントリは `{ "receipt": "rcpt-…", "step": "create-project" }` の形です。
  step 名は引用元の receipt と重複していますが、それでも書き留めます。
  読むために他のファイルと突き合わせなければならない receipt は、単独で読める receipt より劣った受け入れの記録であり、突き合わせる相手になるファイルはローカルな作業記録にすぎず、sign-off(「Sign-off」を参照)よりずっと先に寿命が尽きるからです。
  エントリは receipt id で重複排除され、最初に読まれた順に並びます。
  依存関係はこうして二重に可視になります: 静的には `from` か import として、実行時には receipt 連鎖の provenance としてです。
  値がどの上流の *step* から来たかは、その step ファイルが書かれた時点ですでに決まっていました。
  そのどの *実行* が値を供給したかは、ここでしか分かりません。
- `sections`(空でないときだけ現れます)は、`ctx.section` が呼ばれたラベルを、呼ばれた順に並べたものです。
  `used` と違って重複は除きません。
  ループやリトライで 2 回入ったラベルは 2 回入ったのであり、配列はそのとおりに読めるべきです。
  一方 `used` が receipt id を 1 回しか名指ししないのは、id が一連の中の一点ではなく、1 回引用する価値のある identity だからです。
  タイミングは一切運びません。
  問いは「どこで遅かったか」ではなく「どこで実行が止まったか」だからで、`string[]` は破壊的変更なしに後でより豊かな形へ広げられますが、いま先にその形を作ってしまうと、誰も求めていない部分まで出荷することになります。
  失敗した step の `sections` も、失敗するまでに到達したラベルをそのまま保持しており、その配列の最後の要素がすでに「どの段階にいたか」に答えているため、同じ事実の置き場所をもう 1 つ作る `error.section` フィールドは別途ありません。
  `section` を持つのは typed step の `ctx` だけで、compat step には `this` 上に対応するものがないため、`sections` は単に省略されます。
  これは、typed step が一度も chain から読み取らなかったときに `used` が省略されるのと同じです。
- `required_env`(空でないときだけ現れます)は、この実行中に `ctx.requireEnv` が呼ばれた名前を、初めて読まれた順に重複なく並べたものです。
  `used` や `sections` がすでに持っているのと同じ、宣言ではなく計測という形です。
  `requireEnv` はライブラリが制御できる唯一の呼び出し口だからです。
  キーが見つからず投げる前に記録されるため、`MissingEnvError` で失敗した実行の receipt にも、その step が何を要求したかが残ります。
  記録されるのは名前だけで、値は決して記録されません。
  値は secret になり得るからです。
  `ctx.env[name]` を直接読んだ場合はここには残りません。
  このフィールドが数えるのは `requireEnv` を通った読み取りだけで、ライブラリが関知しないプレーンなオブジェクトの読み取りは含まれません。
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

Configuration は `nukadoko.config.ts`(`defineConfig`)の中にあります: `featuresDir`(デフォルトは `features`。feature ファイルと step のコードは両方ともこの下に置かれる、Cucumber 流のやり方です)、`baseURL`、`envFiles`、`environments`、`stateDir`(デフォルトは `.nukadoko`)、`browser`、`browserContext`、`requestContext`、`secrets`、`parameterTypes`、`allure`(`resultsDir` のみ。Allure emitter を参照)、`messages`(`output` のみ。Messages emitter を参照)。

`browser` は Playwright 自身の `LaunchOptions` 型をそのまま受け取ります(browser の種類は chromium だけです)。
`newContext` の `viewport` のようなオプションは別の Playwright の型であり、この `browser` キーでは受け付けません(下記の `browserContext`/`requestContext` を参照)。
zod は「これがオブジェクトかどうか」以上には形を再検証しません。
型は `defineConfig` から来るため、`tsc` は `nukadoko.config.ts` の他の場所と同じやり方で typo を捕まえます。
Playwright のオプションを zod で列挙し直すと、Playwright が 1 つ追加するたびに追随が必要になり、その追随が追いつくまでのあいだ、config を書く人は本当は使える Playwright のオプションを使えなくなってしまいます。
今日読まれているのは `headless` だけで、そのまま `chromium.launch` に渡されます。
省略した場合は Playwright 自身の既定値(`headless: true`)が適用されます。

`browserContext` と `requestContext` は、`browser` の `launch` に対応する `newContext` 側のキーです。
`browser.newContext()`(`ctx.page()` が使います)と `playwrightRequest.newContext()`(`ctx.request()` が使います)は別々の Playwright 呼び出しであり、オプションの型も別々なので、1 つの共有キーではなくそれぞれに専用のキーを用意しています。
これは `browser` が従っているのと同じ「Playwright 自身の型に委ねる」方針です。
これにより `ignoreHTTPSErrors` のようなオプションに初めて手が届くようになります。
自己署名証明書を使うローカルの接続先では、`ctx.page()` にも `ctx.request()` にもそれを設定する手段がこれまでありませんでした。
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
- `scenarios/<id>/`(scenario の実行ごとに 1 つのディレクトリ: `record.json` と、scenario スコープの evidence(trace.zip、最終スクリーンショット))。
  これは Playwright 自身のテストごとの `test-results/` という規約を 1 階層上でなぞったものです。
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
- working tree が完全にクリーンで(untracked file を含む)、かつ凍結しようとしている run が現在の HEAD で行われたのでなければ拒否します。
  記録の主張はまるごと「この scenario は commit X で green だった」というものです。
  discovery が読み込んだはずの untracked な step ファイルや、run と sign-off の間に行われたコミットは、その主張を偽にします。
  scenario record はこれをチェック可能にするために 1 つのフィールドを増やします(run が始まったときに working tree がどの commit にあったか)。
- red な run は何も生みません。
  verdict のフィールドも失敗の記録もありません(通らなかった scenario は直されて再実行され、残す価値があるのは結果であって、試行そのものではありません)。
- 記録は、それが由来する feature の隣に `<feature-basename>.<date>-<sha>.md` という名前で書かれます。
  nukadoko はディレクトリを選びません(受け入れの作業をどこに置くかはプロジェクトの決定です)。
  これらを regression suite から外したいプロジェクトは feature を `featuresDir` の外に置き、記録もそこに追従します。
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
   引数は実質必須です。
   受け入れの feature は `featuresDir` の外にあり、引数なしの `nuka check` はそこを歩かないからです。
5. commit します。
   run は、まだチェックアウトされているその commit で、クリーンな working tree に対して行われた場合にしか凍結できないため、dirty な working tree に対するデバッグ用の run はかまいません。
   ただそれらは accept できないだけです。
6. green になるまで `nuka run <feature>` します。
7. `nuka accept <feature>` し、それが書いた記録を commit します。

手順 1-4 が作業とレビューの場所です(新しい型付き step と feature 自体は通常の PR の題材であり、基準から scenario への翻訳こそがレビュアーがチェックするための判断です)。
手順 5-7 は機械的であり、ツールは静かに誤って進むのではなく拒否します。

## Allure emitter

`nuka run` は scenario ごとに 1 つの Allure test result を `allure-results/` ディレクトリに書き込みます(Allure 2 のファイル形式で、Allure 2 と 3 の両方で読めます)。
これが nukadoko の唯一の presentation 層であり、nukadoko 自身は何もレンダリングしません。

- 出力先はデフォルトで `.nukadoko/allure-results/` です(上で述べた state directory 自身の `allure-results/` です)。
  `nukadoko.config.ts` の `allure.resultsDir` で、root からの相対パスであれば他の任意の場所に移せます。
  `enabled` フラグも CLI フラグもありません。
  emitter は常に実行されるため、設定ゼロのままで既に完全なレポートが生成されます。
  唯一スキップされるのは `nuka run` の呼び出しが 0 件の pickle を選んだときで(その場合 `allure-results/` はまったく作られません)、これは BeforeAll/AfterAll がスキップされるのと同じ理由です。
- 書き込みは追記のみです: 既存の `allure-results/` ディレクトリがクリアされたり置き換えられたりすることは決してありません。
  2 回の `nuka run` の呼び出しを 1 つの Allure launch とみなすか 2 つとみなすかは呼び出し側に委ねられています。
  新しい launch が欲しいユーザーは、自分でそのディレクトリを削除します。
- scenario の実行は 1 つの Allure test result に対応します: 各 gherkin の step は 1 つの Allure step になり、各 Before/After フックはそれぞれ独立した fixture(Allure container)になります。
- Attachment: scenario 自身の trace とスクリーンショット、そして step ごとにその HTTP ログとバリデーション済みの result です。
  それとは別に、step が自分自身について宣言したもの(attachment、link、ログの一行)も出力され、常に `declared:` を接頭辞に付けた名前の下に置かれます。
  すべてが同じ result ファイルに収まったとき、この接頭辞こそが provenance(nukadoko によって計測されたのか、step によって自己申告されたのか)の生き残る唯一の場所です。
- step の parameter は、その宣言と実際に観測されたものを並べて運びます。
  計測された `http reads (observed)` / `http writes (observed)`(compat の step では `world reads (observed)` / `world writes (observed)` も)の隣に `mutates (declared)` が置かれます。
  この 2 つが自動で照合されるからではなく、レビュアーが自分の目で見比べられるようにするためです。
  宣言は nukadoko が信頼し作用する対象であり、observed の回数は実際に起きたことであり、この行は両者を目で見比べられる場所です。
  observed 側は意味論上の判定ではなく HTTP メソッドによるプロキシです(キーワードの意味論を参照してください)。
  step が POST ベースの読み取りを呼んでいた場合、正直な `mutates (declared): false` の隣にゼロでない `http writes (observed)` が並ぶことがありますが、それはこのプロキシがテーブルに透けて見えているだけであり、どちらの数値も嘘をついているわけではありません。
- 失敗した step や test のメッセージには `[nukadoko.failure=<kind>]` という接頭辞が付き、その receipt が既に持っている同じ `error.kind` を名指しします。
  同じ `error.kind` は `nukadoko.failure` という result label としても書き出されます。
  2 つの Allure 世代は、それを別々の経路で category に変換し、利用者に求めるものも異なります。
- **Allure 2** には result ごとの category フィールドが無いため、emitter は `categories.json` も書き出します(`error.kind` ごとに 1 つの rule、全 7 個、すべての run で、メッセージの接頭辞を正規表現でマッチさせます)。
  メッセージの接頭辞と category の rule は同じ分類を 2 つの視点から見たものであり、利用者側の設定は不要です。
- **Allure 3** の `allure generate`/`allure report` は、結果ディレクトリの `categories.json` を一切読みません。
  そこでの category は Allure 3 自身の config だけから決まり、result の label と照合され、`nukadoko.failure` はまさにそのような label です。
  `examples/allure/allurerc.mjs` は `error.kind` ごとに 1 つ、7 個の label-matcher rule を同梱しています。
  プロジェクトの root に置けば自動で検出されます(Allure 3 はカレントディレクトリから `allurerc.{js,mjs,cjs,json,yaml,yml}` を自動検出するため、`--config` フラグは不要です)。
  それを置かないと、すべての nukadoko の失敗は Allure 3 に組み込まれた 1 つの category「Product errors」に落ちてしまいます。
- Identity(`fullName`/`testCaseId`/`historyId`)は、公式の cucumberjs 用 Allure adapter と同じ方法で計算されます。
  そのため nukadoko に移行するチームは、既存の Allure history と retry tracking をそのまま保てます。
- ad-hoc な `do` の receipt は作業記録であり、test result ではないため、ダッシュボードには現れません。
  探索が証明することは、scenario を修復するか新しく書くことで表現され、その scenario の実行こそが Allure に表示されるものです。
- 表示、履歴、傾向、flakiness はすべて Allure の仕事です。
  nukadoko に web UI はありません。

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

## CLI summary

npm パッケージは `nukadoko` で、それがインストールするただ 1 つのコマンドが `nuka` です。

```
nuka run <feature[:line]>     execute scenarios; receipts + allure-results
nuka do <step> --args '<json>' [--use <receipt-id>]
                              execute one typed step; receipt to stdout.
                              --use supplies its `from` keys from an
                              earlier execution's result
nuka steps [--json]           list the whole vocabulary, typed and compat:
                              name, patterns, description, mutates, and
                              where each chained args key comes from
nuka describe <step>          full contract, schemas as JSON Schema, plus
                              rationale when the step declared one
nuka scaffold <name>          typed step template that fails until implemented
nuka check [feature]          static checks: pattern/schema mismatches, Then
                              binding to mutating steps, undefined steps per
                              feature, ambiguous steps (one line two patterns
                              both match), duplicate patterns, a required
                              `from` key whose producer is absent or bound
                              later in the scenario, a `from` naming a step
                              discovery never registered, config
                              coherence, unreadable step files (reported,
                              not fatal — the rest of the project is still
                              checked), unsupported hook tag expressions;
                              a feature argument checks that one file
                              instead of featuresDir, for a feature living
                              outside it
nuka accept <feature>         freeze that feature's last green run as a
                              committed acceptance record beside it
nuka session list|clear
nuka init [--base-url <url>] [--features-dir <dir>]
                              set up a project; ends with a self-check
nuka skill path               where the bundled skill lives, for a project
                              that wants the copy matching this nukadoko
```

テキスト出力(`--json` なし)は、端末で読む人間向けに整形されます。
`--json` が機械可読な契約です。

## Out of scope(正直な限界)

- step の実装の意味的な真偽は PR レビューに委ねられます。
  ツールが保証するのは入出力の形と、実行された事実だけです。
- nukadoko は、shell アクセスを持つ agent が `.env` を直接読むことを止められません。
  nukadoko がなくすのは、secret が agent の context を通過する構造的な必要性です。
- sign-off は、ソフトウェアが正しいことの証明ではありません。
  それは、合意された scenario が名指しされた 1 つの commit で green だったことを記録するものであり、今日について何も語りません。
- **意図的に driver-agnostic ではない。** `ctx.page()` と `ctx.request()` は Playwright 自身の `Page` と `APIRequestContext` を返し、compat の扉は移行中の glue に、それがすでに使っていたのと同じオブジェクトを渡します。
  それらを nukadoko 自身のインターフェースの背後にラップすれば、そのラッパーが公開し忘れたあらゆる能力を犠牲にし、ユーザーがすでに知っている語彙を、このツールだけが話す語彙に置き換えることになります。
  それは公式の SDK を通して書くことの正反対です。
  引き換えに、別の driver へ後から差し替えるときは public API と compat の扉が同時に壊れます。
  これは見落としではなく、承知のうえで受け入れています。
  step の本体をある driver の API から別の API へ書き換えることは、agent が得意とする作業です。
  portability のために先にコストを払うことは、driver の差し替えでないあらゆる変更を遅くしてしまいます。
  見直すのは、その差し替えの確率が上昇したと計測されたときであり、それより前ではありません。
- テストの並列実行、sharding、retry、CI レポーティングはありません。
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
