# nukadoko 仕様

> nukadoko(あなたの Gherkin のための生きたぬか床): 型付きの step、step record、そして agent-first な CLI。

> 原文は spec.md。相違があれば原文が正。

Status: M1(engine core)実装済み(`steps`/`describe`/`do`/`run`/`check`/`init`/`scaffold`、session、environment、secret)。
M2(compat、後述)も実装済み(`nukadoko/compat`、typed World の計測、移行ガイド)。
実世界での検証ゲートは、いまや両方とも実行済みです。
typed step を実際の feature ファイルに対して起草したゲートと、compat の扉を実際の cucumber-js の glue に対して監査したゲートです(後述)。
まだ 0.x で、M3 以降のうち Allure emitter と messages emitter はどちらも実装済みであり、sign-off(`nuka accept`)と M5 の両方の skill も実装済みです。
`nuka check` における compat gap 検出(migration skill 自身の前提条件)も実装済みで(「Compat steps」と docs/migration.ja.md の「ダッシュボードは `nuka check`」を参照)、M1-M5 を締めくくります。

## nukadoko とは

nukadoko は Gherkin を実行する agent-first のエンジンです。
人間は、feature ファイル、型付き step 定義、sign-off record という耐久性のある成果物を書き、レビューします。
agent はそれらの成果物を実行します。
実行系は agent の試行錯誤のループを支えます。
すべての step は型付きの契約を持ち、CLI から単独で実行できます。
実行するたびに、agent ではなくツールが書いた step record が残ります。
shell アクセスを持つ agent はどんなファイルでも書けるため、この record も偽造できます。
ここでの違いは、誰も agent に record の作成を頼む必要がなかったことです(詳しくは「Out of scope」を参照)。

Agent-first は設計上の制約であり、スローガンではありません。
agent は介助なしにループ全体を完了できなければなりません。
agent は語彙を発見し(`nuka steps --json`)、契約を読みます(`nuka describe`、スキーマは JSON Schema です)。
次に、1 つの step を実行します(`nuka do`、step record は stdout に出力され、意味のある exit code を返します)。
その後、バリデーション済みの結果を読み、次の呼び出しを決めます。
語彙に操作が欠けているときは、agent が新しい step を scaffold して実装し、人間がその PR をレビューします。
あらゆるインターフェースは機械可読な形(`--json`)を持ち、Allure が人間向けのリッチなレポートを提供します。

この制約から生じる帰結の一つが、このツールの成長する方向を決めます。
E2E 実行には、ブラウザ、実物のターゲット、分単位の時間が必要です。
unit test には、このようなコストがありません。
実際の反復速度は、シナリオのどれだけを**実行せずに**誤りだと判定できるかに左右されます。
agent の場合、これは安価なコマンドから成るループが自らの作業を正す速さを直接決めます。
この仕様が求める各宣言は、そのコストを減らします。
`pattern` と `args` により、`check` はブラウザを開く前に行を拒否できます。
`mutates` により、Then に疑問を示せます。
`from` により、step の順序では失敗するしかない scenario を拒否できます。
したがって、`nuka check` が判定できる範囲を広げることは、便宜ではなく一級の目標です。
失敗した run の後には、check がその失敗を先に検出できたかを常に問います。
誠実さがその限界を決めます。
`check` が主張するのは、起こり得る結果が一つしかない場合だけです。
推測で判定する check は、信頼できる check まで無視するよう人を慣らしてしまうからです。

ぬか床とは、きゅうりを漬物に変える米ぬかの発酵床のことです。
ぬか床は生きています。
毎日手入れをすれば熟成し、放っておけば死にます。
nukadoko は step 定義についても同じ主張をします。
step 定義は書いて終わりのテスト資産ではなく、生きた培養菌であり、agent が手入れします。

nukadoko は意図的に、所有する範囲を最小限にとどめています:

| 関心事 | 担当 |
|---|---|
| Gherkin の構文(Background、Scenario Outline、tables、docstrings、tags) | `@cucumber/gherkin`(feature を平坦な「pickle」にコンパイルする公式パーサ) |
| Step のパターンマッチング(`{string}`、`{int}`、カスタム parameter type) | `@cucumber/cucumber-expressions` |
| 見やすいレポート | Allure(nukadoko は `allure-results` を出力するのみで、HTML のレンダリングは行いません) |
| 「何が何を証明するか」の承認 | git(feature と step 定義の PR レビュー、CODEOWNERS) |
| **型付き step の契約** | **nukadoko** |
| **実行と計測(record)** | **nukadoko** |
| **Session、environment、secret** | **nukadoko** |
| **キーワードの意味論(Then は mutate してはならない)** | **nukadoko** |
| **Sign-off の記録** | **nukadoko** |

## 課題

ここでは、独立した 2 種類の腐敗が出会います。

**BDD の腐敗。**
Cucumber では、パターンが step 定義をグルーコードとして自然文に結び付けます。
グルーコードのライブラリは、目に見える合図がないまま劣化します。
重複した step が積み重なり、undefined な step は実行時になって初めて表面化します。
step が何を受け取り、何を返すかを定める型はありません。
何が送信され、何が受信されたかを記録しないため、レポートは「passed」としか言えません。
キーワードは装飾に過ぎません。
Cucumber は Then を Given とまったく同じように実行するため、assertion の step が状態を mutate することを防げません。

**agent の腐敗。**
AI の agent が受け入れ確認のためにブラウザ操作を即興で行うと、その agent は実行者と結果の報告者を兼ねます。
その構造では、agent が何も実行せずにもっともらしい結果を報告することを防げません。
即興で行った操作は、レビュー可能な成果物も残しません。

nukadoko は両方の欠落を塞ぎます。
操作の語彙はコミットされ、型付けされ、レビューされます。
ツールが実行を所有し、人の説明を信じる代わりに実際に起きたことを計測します。

## 成果物

nukadoko が扱うものはすべて、5 つの種類のどれかに属します。
誰が書くか、リポジトリに属するか、どれだけの期間を想定するかによって種類が決まります。

| 目的 | 成果物 | 書く | コミット | 寿命 | 読む |
|---|---|---|---|---|---|
| Contract | `.feature`、step 定義、`nukadoko.config.ts` | 人 | する | 永続 | 人、エンジン |
| Measurement | `.nukadoko/records/steps/<id>/`(`record.json` とその evidence)、`.nukadoko/records/scenarios/<id>` | ツール | しない | `nuka clean` が消すまで | `nuka accept`、Allure emitter と messages emitter、`nuka do --use` |
| Sign-off | `<feature のベース名>.<date>-<sha>.<environment>.<browser>.md`、feature の隣 | ツール(`nuka accept`) | する | 永続 | 人、PR レビュー、`nuka tend` |
| Export | `.nukadoko/export/allure-results/`、`.nukadoko/export/messages.ndjson`(その隣に、`nuka run` の呼び出し 1 回につき 1 つ増える run-id 付きファイルも。こちらも `nuka clean` が消すまで残る) | ツール | しない | 使い捨て | 他のツール |
| Cache | `.nukadoko/cache/sessions/` | ツール | しない | 使い捨て | `nuka run` / `nuka do` |

この表が名指しているのはファイルです。
列の間にある区別は、「これを消すと何が起きるか」と「誰がこれを変えてよいか」という 2 つの問いに答えます。

- **Export が使い捨てなのは、導出されたものだからです。**
  消すと、次の `nuka run` が新しいものを書きます。
  Allure の CLI や CI の formatter など、nukadoko の外側の読み手のために存在します。
  nukadoko 自身は決して読みません。
- **Cache が使い捨てなのは、別の理由からです。**
  何かが起きたことを記録しません。
  避けられた作業だけを表し、session ファイルがあれば、後の呼び出しで再ログインを省けます。
  消すとログインし直す必要がありますが、正しさには影響しません。
- **コミットされるのは Contract と Sign-off だけです。**
  Contract は人が書き、レビューした約束です。
  Sign-off は、その約束が green で通った後にツールが凍結した主張です。
  Measurement は決してコミットされません。
  `nuka init` は Measurement を置く state directory を gitignore します。
  1 回の run の作業記録は、次の run について何も語らないからです。
- **Measurement の「run ごと」という寿命は、`nuka clean` ができるまでは願望にすぎませんでした。**
  run が終了しても、その step record と scenario record は削除されませんでした。
  `nuka do --use` と `nuka harvest` は意図的に過去の日の record を読むため、自動削除は選択肢になりませんでした。
  現在は、`nuka clean [--records] [--cache] [--export] [--dry-run] [--json]` が明示的に削除します。
  カテゴリのフラグを指定しなければ、3 つのカテゴリをすべて消します。
  カテゴリのフラグを 1 つ指定すると、操作をそのカテゴリだけに限定します。
  `--dry-run` は実際の run と同じ計画を出力しますが、何も消しません。
  どこかに live な session が 1 つでもある場合、このコマンドはすべてのカテゴリについて操作全体を拒否します。
  session のプロセスが records と export の出力を引き続き書く可能性があるためです。
  この規則は、`nuka session clear` が live な lock を拒否するのと同じ理由で、すべての environment に適用されます。
  1 つの export ファイルだけは常に例外です。
  `export/allure-history.jsonl` は `allure-results/` の中ではなく、その隣にあります。
  ここにある成果物のうち、新しい run で再現できないものはこのファイルだけです。
- **step record と scenario record は同じ 1 行にいます。**
  違うのは粒度だけです。
  scenario record と各 step record は、異なる 2 つの問いではなく、同じ問いに 2 つの解像度で答えます。
  `nuka do` には record を書く対象の scenario がないため、step record だけを書きます。
  「record」は両方の種類を指します。
  ファイルの分割が表すのは粒度であり、別の概念ではありません。

## 型付き step

nukadoko は Cucumber のレイアウト規約に従います。
feature ファイルとそれを支えるコードは、`features/` の下に一緒に置きます。
移行するチームは、自分たちのメンタルモデルとディレクトリ構成をそのまま保てます。
型付き step は `features/steps/` に置き、1 つのファイルに 1 つの step を定義します: `features/steps/<name>.ts`。
ファイル名には kebab-case を使い、その名前が step 名になります。

discovery は `featuresDir` を歩き、`.ts`、`.mts`、`.js`、`.mjs` の各ファイルを対象にします。
step 名は、ファイル名から拡張子を取り除いた名前です。
discovery は、どの深さでも `node_modules` と `.git`、`.nukadoko`、`.vscode` などのドットディレクトリをスキップします。
`.d.ts` と `.d.mts` は step 定義ではなく型宣言であるため、対象から除外します。

discovery は `.cjs` ファイルを特定しますが、インポートしません。
nukadoko は ESM-only です。
同じ CommonJS の go/no-go については、後述の「Compat steps」を参照してください。
`nuka check` は、そのファイルを `step-file-unsupported-extension` として報告します。
この報告により、そのファイルの定義が説明のつかない `undefined-step` として再び現れることを防ぎます。

リポジトリのルートなどを `featuresDir` に設定すると、同じように歩く範囲が広がります。
その木の中にあるビルド成果物も、名前が上記 4 つの拡張子のいずれかで終わる場合は glue になり得ます。
`node_modules` とすべてのドットディレクトリは、`featuresDir` の設定にかかわらず除外されます。

広い設定は、`nuka check` が見つけるものだけでなく、その動作も変えます。
discovery は歩いた各ファイルをインポートします。
そのため、モジュールは本来読み取り専用のコマンド中に環境を読み、接続を開き、ファイルを書けます。
`featuresDir` がアプリケーションと glue の両方を含む場合、discovery はアプリケーションのトップレベルのコードを実行します。

```ts
import { defineStep, z } from "nukadoko";

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
- 上記のキャプチャ除去とマッチングの仕組みは、`nukadoko/matching` の `resolveStaticPattern` として単体でも export されています。
  pattern を 1 つ渡すと(`kind: "typed"` または `"compat"`、string または RegExp)、テキストに一致するかどうかを返す関数か、追跡可能な理由付きの `ok: false` のどちらかを返し、黙って `false` を返すことはありません。
  これは `nuka run` がすでに構築しているのと同じマッチングの仕組みを呼び出すのであって、2 つ目の実装ではありません。
  そのため、このパッケージの外にある呼び出し元(たとえば、Gherkin の行がどの step に結び付くかを解決するエディタ)と `nuka run` 自身とが、pattern が何に一致するかについて食い違うことは決してありません。
  解決に使う parameter type はビルトインだけです。
  ワークスペース自身の `config.parameterTypes` や compat の `defineParameterType` 呼び出しを解決するにはそのワークスペースのコードを実行する必要があり、純粋に静的な呼び出し元の範囲外です。
- `args` / `returns` は zod のスキーマで、実行境界でバリデーションされます(args は実行前、returns は実行後)。
  バリデーションの失敗は失敗した実行として扱われ、result は保存されません。
  キャプチャは parameter type によって型強制され(`{int}` → number、カスタム型はそれぞれの transformer による)、そのあとスキーマが契約になります。
  この対応関係は双方向に静的にチェックできます(`nuka check`)。
  スキーマのキーを持たないキャプチャはエラーです。
  ある行の何によっても埋まりようのない **required** なスキーマキーも同様にエラーです(キャプチャも table/docstring も `from` もない)。
  その行は args のバリデーションに失敗する以外にありえないからです。
  この逆方向は、キーが何かツールに見えない方法で埋まっているかもしれないという理屈のもと、しばらく未チェックのままでした。
  `from` が残る方法を可視化することでその隙間を埋めたため、残っているのは単に説明されていないだけでなく、正真正銘埋まりようのないものです。
- pattern、table/docstring、`from` のどれも埋めず、しかもスキーマが宣言していない args キーは、黙って捨てられるのではなく拒否されます。
  `nuka describe` はすでに各オブジェクトの `args` スキーマ自身の `additionalProperties: false` を公開しています。
  step の `args` をバリデーション済みの値に変える経路はすべて、同じ閉じた形に対してパースします。
  対象は `nuka do`、`nuka do --session <live>`、`nuka run`、`recordStep`、part が呼ばれる `call` fixture です(「Parts」を参照)。
  `from`/`--use` が埋めるキーは決して指摘されません。
  どちらも、その step 自身が宣言したキーしか名指せないからです。
  成功した record の `args` は検証済みの値そのものなので、スキーマ自身の `.default(...)` が埋めたキーは、その行で誰も書いていなくても現れます。
  失敗した record は与えられたものをそのまま保持します。
  読み手が生の値をもっとも必要とするのがそこだからです。
  part 自身の `CallEntry.args`(「Records」を参照)は、どちらの結果でも生のままです。
  ここで変わったのは何を受け入れるかであり、何を書き残すかではありません。
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
  その指針は、この step 自身の正しさが依存しているのに下流の何にも読まれない値(計算した日付、選んだ id、送信前に解決した名前)をすべて落としてしまいますが、それらこそまさに run が失敗したあとに step record が問いただされる値です。
  返せば step record 上にバリデーション済みの事実として載り、「実際には何を送ったのか」という問いに答えがあります。
  返さなければ、その答えは他人のシステムが書いたエラーメッセージから再構築するしかありません。
  これは `observed` と `sections` 自身の「計測して残す」という理屈を、step 自身が埋める唯一のフィールドに適用したものです。
- `visible: false`、`count: 0`、空文字列のように不在を主張する観測は、存在を主張する側には無い曖昧さを、まさにその形で抱えます。
  対象が本当にそこに無いのか、ページがまだ描画を終えていないだけなのかのどちらかであり、step が別途言わない限り、この 2 つの状況は step record 上で同じ値を生みます。
  `returns` が不在を運びうる step は、その隣に、読み取り自体が妥当だったことを証明する何かを運ぶべきです。
  つまり、不在が早すぎる問い合わせの症状ではなく本物の答えである状態に、ページが達していたことです。
  それが無ければ、レビュアーが step record から立てられるどの仮説も等しくそれと整合してしまい、それが反証不可能ということの実際の意味です。
  存在の主張にはそうした連れ添う証拠は要りません。
  `visible: true` は、その読み取りが描画済みのページに着地したことをそれ自体で証明します。
  隠れた要素も未描画の要素も `true` を生み出せないからです。
  肯定の主張はそれ自身を保証し、否定の主張はそうしないという、この非対称性こそが、両者に同じ規約を当てはめるのではなく別々に扱う理由です。
  これが最も効いてくるのは、一見無関係に見える場面です。
  「条件が満たされない限り非表示」と書かれた受け入れ基準は、未描画のページが生み出すのと同じ `false` によって満たされてしまうため、それを主張する scenario は、ページが一度も読み込みを終えないまま green になり得ます。
  間違った理由で green になったのか正しい理由で green になったのかは、step record に readiness の証拠が無い限り見分けが付きません。
  受け入れ基準を、起きたか起きなかったかのどちらかである実行に結び付けることが目的のツールは、それを些細な隙間として扱うわけにはいきません。
  それこそがその隙間です。
- `mutates`(デフォルトは `true`)は、その step が触れる範囲のどこかで状態を変更するかどうかを表します。
  読み取り専用の step は `mutates: false` を宣言します。
- `parts`(デフォルトは `[]`)は、この step 自身の `run` が `call` fixture を通じて呼び出すことがある step を列挙します(「Parts」を参照)。
  どれも呼ばない step はこれを省略でき、`from` と同じ慣習です。
- `rationale` は任意で、デフォルト値を持ちません。
  省略すると `Step.rationale` は `undefined` になり、`pattern` と同じ慣習です。
  `description` とは別の問いに答えます。
  `description` はその step が何をするかで、`nuka steps` が一覧するのはこの情報であり、agent はそれを見てどの step を呼ぶか選びます。
  `rationale` はなぜこう実装したのか、何を試して何を捨てたのかで、agent が「この step を書き換えてよいか」を決める前に必要とする情報です。
  `nuka steps` の一覧には決して現れず、表示するのは `nuka describe` だけです。
  step record にも現れません。
  step record は 1 回の実行を記録するものであり、rationale はその step のどの record でも同一になる契約の属性であって、実行が生み出したものではないからです。
- `run` の本体は、自分が分割代入した fixture の上で自由に書ける TypeScript です。
  合成とは、別の step モジュールをインポートし、同じ fixture bag でその `run` を呼び出すことです。
  共有ヘルパーは通常のモジュール(例: `features/steps/lib/`)に置きます。
- 意味的な正しさ(実装が description と pattern の主張どおりに動くかどうか)は、ツールではなく PR レビューによって保証されます。
  `steps/` は CODEOWNERS で保護してください。

### Context API

step の `run` は、素の分割代入パターンで **fixture bag** を受け取ります: `run({ page, section }, args)`。
名前はアルファベット順に並べます。
executor は、step が分割代入した fixture だけを構築します。
step が `page` も `context` も名指さなければ、その step のためにブラウザを起動しません。

ブラウザの動作は、中心となる設計目標から生じる帰結です。
`run({ page }, args)` は「page を渡してほしい」という意味ではありません。
このオブジェクトパターンは、`check` が `run` を呼ばずにパースする静的な宣言です。
`check` はすでに `pattern`、`args`、`returns`、`from` も実行せずにパースします。

したがって、step の作成者はファイルを書くときに `page` を宣言します。
step が実行時の動作で `page` を要求するわけではありません。
`check` は `run` のソーステキストをパースし、executor は同じ宣言から fixture を構築します。
静的チェックと実行は、一つの情報源を使います。

`from` は、step の出力についてこの設計を確立しました(「step の連鎖」を参照)。
静的な宣言は、実行を後から説明せずに制御します。
fixture bag は、同じ設計を資源に適用します。

Playwright の fixture も同じ分割代入構文を使いますが、この類似が設計を決めたわけではありません。
Playwright では、このパターンが runner に構築対象を指示します。
nukadoko では、このパターンがまず `check` に宣言を渡します。
その結果として、パターンは構築指示にもなります。

fixture の名前:

- `page: Page`: session の storageState から復元された Playwright の Page です。
  設定された baseURL は browser context に渡されるため、`page.goto("/path")` はそれを基準に解決されます。
  標準の URL 規則が適用されます: 先頭のスラッシュは、baseURL 自身のパスに追加されず、そのパスを置き換えます。
  この動作は、Playwright 1.61.1 と `baseURL: "https://demo.playwright.dev/todomvc/"` を使って計測しました。
  `goto("/")` はホスト自身の根である `https://demo.playwright.dev/` に着地します。
  `/todomvc/` 配下のアプリには着地しません。
  `goto("./")` と絶対パスの `goto("/todomvc/")` は、どちらも `https://demo.playwright.dev/todomvc/#/` に着地します。
  アプリがパスの下にあるスイートは、最初のナビゲーションでこの 2 つの書き方のどちらかを使います。
  そこでは、先頭が裸のスラッシュを使いません。
  ブラウザは、step 自身の bag が構築されるときに起動します。
  ブラウザが起動するのは、`page` または後述の `context` が step の分割代入した名前に含まれるときだけです。
  ブラウザがそれより早く起動することも、どちらの fixture も名指さない step のために起動することもありません。
- `context: BrowserContext`: `page` がすでに属している `BrowserContext` です(`page.context()`)。
  2 つ目の context ではありません。
  step は `context.newPage()` で 2 枚目のタブを開けます。
  step は、executor が公開していない後述の `browser` を必要としません。
- `request: APIRequestContext`: session の cookie を持つ Playwright の APIRequestContext です。
  上の `page` と同様に、`baseURL` は任意です。
  複数のホストに絶対 URL だけでアクセスするスイートには、指定する単一の baseURL がありません。
  nukadoko は、この fixture を満たすためだけに baseURL を config へ強制しません。
  `baseURL` が未設定の状態で step が相対パスを渡すと、Playwright がエラーを発生させます。
  nukadoko は、そのエラーを先に防ぐために Playwright の URL 解決を再実装しません。
- `env`: 設定された envFiles から得た読み取り専用の環境変数です。
  この fixture は決定論を強制します: プロセス環境は決してマージされません。
  secrets の redaction も強制します: redact できるのは nukadoko がロードした値だけです。
  これは便利機能ではありません。
- `requireEnv(name)`: `env[name]` と同じ値を返します。
  必須の変数を読む各 step が自分で書くことになる存在チェックを提供します。
  値が欠けていると投げるため、`undefined` ではなく `string` を返します。
  空文字列も欠落として扱います。
  envFile の `KEY=` という行は「キーが省略された」ではなく `""` にパースされます。
  変数を必須と宣言した step は、どちらの場合も同じように壊れています。
  エラーはキーだけを名指しし、値を決して含みません。
  欠落した値には示す値がありません。
  値を決して運ばない形は、後から redaction の抜け穴にはなりません。
  エラーは、修正する envFile を特定できません。
  この fixture が見るのはマージ済みの結果だけであり、`config.envFiles` のリストは決して見ません。
  すべてのキーを一度に必要とする稀な step のために、`env` は残ります。
  `requireEnv` に渡したすべての名前は、step record の `required_env` に記録されます(「Records」を参照)。
  呼び出しが値を見つけた場合も投げた場合も、この記録が行われます。
  名前は読み取り順に並び、重複が除かれます。
  同じ値を `env` から直接読むと、記録は残りません。
  その経路はプレーンなオブジェクトなので、ライブラリは読み取りを認識しません。
- `baseURL`: 手作業で URL を組み立てる稀な場合に使う、設定済みの baseURL です。
  一般的な経路には、上記のとおり baseURL が渡されます。
  `config.baseURL` が未設定のときは `undefined` です。
  絶対 URL だけを使うスイートでは、これは正当な状態です。
  エラー状態ではありません。
- `resultOf(stepModule)`: 現在の scenario で、その step が直近に成功した実行のバリデーション済み result を返します。
  `nuka do` の下、またはその step がまだ成功していない場合は `undefined` を返します。
  これは scenario 経路のデータチャネルです。
  意図的に World にはしていません。
  ここには何も書き込めません。
  読めるのは、`returns` スキーマを通過した result だけです。
  依存関係は、他の step モジュールへの目に見える `import` です。
  その step 自身のスキーマが依存関係を型付けし、diff は依存関係をレビュー可能にします。
  「その listing は閉じている」のような feature の一文は、参照先がバリデーション済み result を生成したときだけ実装できます。
  `from` は同じ読み取りの宣言的な形です(「step の連鎖」を参照)。
  まず `from` を使います。
  `resultOf` は、キー名で表せない読み取りのために残ります。
  discovery が登録しなかった `Step` を渡すと、`undefined` を返さずに投げます。
  この規則が捕まえる間違いについては、「step の連鎖」を参照してください。
- `await call(stepModule, args)`: この step が `parts` で宣言した step のひとつを実行し、バリデーション済み result を返します(「Parts」を参照)。
  part 自身の `args` スキーマが args をバリデーションします。
  part の `returns` スキーマが result をバリデーションします。
  呼び出しは、この step 自身の step record の `calls` 配下に記録されます。
  `parts` が宣言していない step は、実行せずに投げます。
  discovery が登録しなかった step も、実行せずに投げます。
- `section(label: string): void`: 実行が名前の付いた段階に到達したことを記録します。
  同期的であり、返り値はありません。
  対になる「終了」呼び出しはありません。
  すべての呼び出しは、呼び出し順に step record の `sections` へ追加されます(「Records」を参照)。
  一度も呼ばない step には `sections` キーがありません。
  これは `used` と同じ規則です。
  意図的に、ブロックを囲む関数(`section(label, fn)`)ではなく、裸のマーカーにしています。
  ブロックを囲む形では、入れ子、早期 `return`、境界をまたぐ `await` の意味を定義する必要があります。
  この fixture が答える問いには、これらの定義は必要ありません。
  この fixture は、止まったブロックの形ではなく、実行が止まった場所を記録します。
- `await poll(fn, { description, timeout, interval })`: 要求されたがまだ存在しない状態のための submit-poll-fetch ループです。
  `fn` は、その状態が存在するまで `undefined` を返します。
  `poll` は、最初の定義済みの値を返します。
  `timeout` の予算が先に尽きると、`poll` は `PollTimeoutError` を投げます。
  完了したすべての呼び出しは、step record の `polls` に保存されます(「Records」を参照)。
  record は、試行回数、待機時間、結果を示します。
  `fn` が poll する値は、実装の詳細ではなく契約上の選択です。
  その値を観測対象自身の存在にすることはできません。
  その場合、正しい合格状態が不在である対象は、まだ描画されていない対象と見分けられません。
  存在を poll すると、`fn` は step が答えるべき結果を返せません。
  代わりに、対象について断定できるようにする条件を poll します。
  たとえば、loading フラグが false になる、count が定義済みになる、データの到着後に page が必ず何かを描画する、という条件です。
  その条件が解決した後だけ、対象を読みます。
  `page.waitForSelector` または `waitForLoadState` を使うブラウザ上の直接の待機も同じように待ちますが、record は残しません。
  `poll` を使うと、`at`、`attempts`、`waited_ms`、`outcome` が step record に追加されます。
  これらのフィールドだけが、事後に「最初の試行で解決し、待機は何もしなかった」と「4 秒後に解決した」を区別できます。
  これは、Allure emitter が `declared:` 接頭辞で示す、自己申告と計測の間の同じ境界です(「Allure emitter」を参照)。
  ここでは、その境界が、ツールが計測した待機と Playwright 内で見えずに発生した待機を分けます。
- `evidence.attach(name, body)` / `evidence.path(name)`: 他の fixture が扱わない唯一の不足を埋めます。
  上の他の fixture はすべて、harness が自分で収集するものを返します。
  以前は、step だけが生成できるアプリ固有の証跡を受け取る fixture がありませんでした。
  たとえば、API response body、DB snapshot、生成したファイルの内容です。
  `attach` は `body`(`string | Uint8Array`)を、この実行自身の evidence directory に書き込みます。
  このファイルを step record の `evidence.attachments` に記録します(「Records」を参照)。
  同じ `name` で 2 回呼ぶと、最初のファイルを上書きせず、両方のファイルを残します。
  `path` は Playwright 自身の `testInfo.outputPath()` です。
  何も書き込まずに、同じ directory の下へ衝突しない絶対パスを割り当てます。
  step record に載るのは、実行が終わる前に step が書き込んだパスだけです。
  `path()` の呼び出し後に書き込まなければ、何も追加されません。
  両方のメソッドが 1 つのオブジェクトにあるのは、executor から同じ情報を必要とするからです: この step 自身の evidence directory です。
  step が一方のメソッドを必要とする頻度は、もう一方を必要とする頻度とほぼ同じです。
  パス区切りを含む `name` は拒否されます。
  `.`、`..`、空文字列のいずれかと等しい `name` も拒否されます。
  nukadoko は、これらの名前を黙って書き換えません。
  step が要求していない名前を信頼するよりも、その呼び出しで明確なエラーを出す方が適切です。

待ちがどこに属するかは契約の問題であり、便利さの問題ではありません。
効果が非同期に別の場所へ現れるシステムに書き込む step は、書き込みが受理された時点では終わらず、次の step が見る対象に効果が現れた時点で終わるため、待ちはその step の内側に属します。
これは「契約はその step が何を要求するかを言う」という規則を、後ろ向きではなく前向きに読んだものです。
代わりに待ちを後続の step に置くと、その step が待って scenario が通るため、うまく動くように見えますが、待ちは必要とした操作ではなく経路に付き、同じ状態へその step を通らずに到達する別の scenario は何も待たずに失敗します。
その結果、一つの scenario だけが red になり、兄弟の scenario は green のままなので、その scenario 固有の性質に見えますが、実際は違います。
green な scenario は待ちが正しく置かれている証拠にはならず、必要な待ちが偶然さらに下流から供給された可能性があるため、それらを通らない経路だけが待ちの本来の所属先を示せます。

`page` と `request` は、nukadoko 自身の型ではなく Playwright 自身の `Page` と `APIRequestContext` をそのまま返します。
これは代償を伴う選択であり、その代償ごと「Out of scope」に明記してあります。

`expect` は fixture ではありません。
step は `import { expect } from "playwright/test"` で直接インポートします。
matcher が Playwright のテストと同じようにアサーションするかどうかは呼び出し対象だけでは決まらず、`toMatchAriaSnapshot`(locator)、`toHaveScreenshot`(`page`)、`toMatchSnapshot`(値そのもの)は、`toBeVisible`、`toBe`、`expect.poll` と同じ 3 種類の対象を取りますが、runner の外ではいずれも `"<name>() must be called during the test"` を投げます(Playwright 1.61.1 で計測)。
違いを決めるのは matcher が runner の現在のテストに紐づく snapshot ファイルを読み書きするかであり、step には現在のテストがありません。
これは他の fixture と同じ規則から生じます: fixture は executor が注入する必要のあるものだけを運び、`expect` は executor が所有するものを必要とせず、アサーションの証跡はすでに trace の `actions` を通じて step record に届くため(「Records」を参照)、fixture にすると Playwright が公開済みの export の裏に何もないメンバーを追加するだけです。

`browser` も fixture ではなく、これは省略ではなく拒否です。
`context` は fixture なので、2 枚目のタブが要る step は、何も新しく起動せず、`page` がすでに属している context の `context.newPage()` を使います。
`browser` そのものを渡すと、step は `browser.newContext()` を呼び、executor が認識しない、計測も trace もされず、その run が書くすべての step record の外にある context を作れます。
この名前を bag から外すことで、その経路を常に到達不能にし、step が破らないよう覚えておく慣習にはしません。

2 つの形、デフォルト値を持つ分割代入された fixture(`{ page = ... }`)と rest プロパティで集める fixture(`{ ...rest }`)は、誤って部分的に解析されず、そのまま拒否されます。
どちらもこの節の冒頭で述べた静的な読み取りを損ないます: デフォルト値は `check` が明確に読める名前を壊し、rest プロパティが束縛する名前は分割代入を実行しなければ分からず、`check` は実行してはいけません。
どちらを拒否しても、fixture が正当に必要とするものは失われません: fixture は名指された時点で必ず存在するため、デフォルト値が使われることはなく、step が必要とする fixture はすべて明示的に名指せます。
`check` と `nuka run`/`nuka do` はこの判定を共有するため(「step の連鎖」で `from` に使う「一つの判定を 2 つの呼び出し元が共有する」形と同じです)、step が `check` を通過して実行時に拒否されることも、その逆もありません。
未知の fixture 名、デフォルト値、rest プロパティは、いずれも実行前に実行そのものを拒否し、未定義の step と同じ「開始しなかった」という結果になり、step の失敗にはなりません。

この読み取りは `check` の外にも公開されます: `nuka steps --json` は、各 typed step が分割代入した名前を `needs` として報告し、名前をアルファベット順に並べ、何も必要としないときは `[]` を返し、`page` または `context` を含むかを `needs_browser` で示します。
そのため agent は scenario を選ぶとき、実行前にブラウザを開かない step を識別できますが、ブラウザを使う scenario には API だけの scenario にはない分単位の時間と実物のターゲットが必要です。
同じ静的な読み取りが解析できない `run()`、つまりデフォルト値、rest プロパティ、または分割代入パターンの位置に裸の識別子がある場合、`needs` は `[]` ではなく `null` になり、そのエントリの `needs_error` が理由を示し、導けないブラウザ要否を主張しないため `needs_browser` もありません。
その step 自身の name、patterns、description は引き続き報告されるため、一つの読めない `run()` が残りの一覧を失わせることはありません。
呼び出しのトップレベルは step のベタな配列ではなく `{ steps, import_failures }` であり、`import_failures`(`{ file, message }`)は import に失敗したすべての step ファイルを名指しし、常に存在し、失敗がなければ `[]` です(下の「報告は寛容に、実行は速く失敗する」を参照)。

このうち移行前の形である `run(ctx, args)` の裸の分割代入されていない第一引数については、同じ呼び出しが `needs_inferred` も報告します: これは step の fixture 要求についての字句上の推測であり、`run` 自身のソーステキストをその引数のメンバアクセス(`ctx.page`)について走査し、既知の fixture 名だけに絞ります。
これは独立したフィールドであり、`needs` には混ぜません: `needs` は分割代入パターンから読み取った、executor が step の実行前に実際に構築する対象ですが、`needs_inferred` はまだ実行できない step についての推測なので、両者をまとめると、この読み取りが裏付けられないものまで確実だと述べることになります。
上の `needs: null` と同じく、`needs_browser` も一緒に推測されません。
この走査は意図的に網羅的ではなく、エイリアス(`const c = ctx; c.page()`)を追わないため、読み手は完成した一覧ではなく、出発点となる一覧として扱う必要があります。
throw が走査に使う識別子を運ぶ場合だけ、このフィールドが存在します: デフォルト値または rest プロパティによる throw は走査の手掛かりを残さないため、エラーがなく推測対象もない step と同様に、`needs_inferred` を省略します。

fixture と同じ名前のローカル変数は fixture を覆い、`run` の関数直下で宣言して分割代入されたパラメータ自体と衝突する形だけが実行前に検出され、esbuild がファイルの transform を拒否します(`The symbol "page" has already been declared`)。
代わりに `if`、ループ、コールバックなどのネストしたブロックで宣言すると、衝突があっても読み込まれます: `tsc` には独立して型が整合する通常のローカル束縛に見え、`check` は `run` の第一引数の分割代入パターンだけを解析して本体を読まないため、どちらも指摘できません。
問題が表に出るのは実行が覆われた名前へ到達したときだけであり、その時点でも必ず失敗するとは限りません: Playwright は `click`、`fill`、`hover`、`screenshot` などのメソッド名を `Page` と `Locator` の間で意図的に共通化しているため、`Locator` に覆われた `page` は本物の `page` と同じ呼び出しに応答し、例外を投げずに別の要素を操作する可能性があります。
fixture を分割代入パターンのエイリアス構文で受け取ると衝突を避けられます: `run({ page: pwPage, section }, args)` では衝突対象が残らず、ネストしたスコープ内で `page` を別の対象へ自由に束縛できます。
この方法は契約を変えません: `fixtureParameterNames` はコロンの左側の名前を読むため、`{ page: pwPage, section }` と `{ page, section }` はどちらも `["page", "section"]` になり、`needs`、`needs_browser`、fixture の解決は同じ一覧から導かれます。
nukadoko は現在この shadowing 自体を検出しないため、上の説明は検出するという主張ではありません。

### Fixtures

「Context API」の fixture bag は閉じています。
含まれるのは、`page`、`context`、`request`、`env`、`requireEnv`、`baseURL`、`resultOf`、`call`、`section`、`poll`、`evidence`だけです。
step は、テナント、シード済みデータベース、アップロード済み fixture ファイルなど、プロジェクトの資源も必要とする場合があります。
以前は、その片付けコードを置く適切な場所が step にありませんでした。
step 内の片付けは、受け入れ条件ではないものを feature ファイルに加えます。
片付けを省くと資源が漏れます。
`nukadoko.config.ts` が必要な場所を提供します。

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

fixture は素の関数か、`[function, options]` のタプルです。
Playwright の fixture 定義もこの 2 つの形を使います。
したがって、すべての依存が `page`、`context`、`request`、`baseURL` なら、`base.extend()` は変更のない fixture を受け取れます。
この共有部分は定義の形だけを表します。
それより広い互換性の約束ではありません。
`env`、`section`、`poll`、`resultOf`、`call`、`evidence`、その他の nukadoko 固有名を分割代入する fixture を Playwright の runner は理解しません。
nukadoko は `auto: true` も拒否し、メッセージで理由を説明します。
このオプションを使うと、利用側が要求していない fixture を Playwright が構築できます。
feature ファイルは実行されたものをすべて名指す必要があるため、nukadoko は要求されていない fixture を構築できません。
このパッケージが約束するのは、同じ定義の形を受け取ることだけです。
それより広い Playwright fixture 互換性は約束しません。

両方の runner の背後に 1 つの共有 `fixtures.ts` を置かないでください。
TypeScript は、インラインのオブジェクトリテラルだけに文脈型付けを適用します。
fixture map を素の `export const` にするとその型付けを失い、`strict` で失敗します。
nukadoko では、同じオブジェクトリテラルを `nukadoko` パッケージの `defineFixtures` に渡してください。
TypeScript はそのオブジェクトリテラルをインラインとして扱います。
`request` と `use` の両方に、手書きの注釈なしで完全な型が付きます。
別のユーザー定義 fixture への依存は、引き続き `unknown` 型になります。
その宣言型には自己参照的な型推論が必要です。
実測時にはドキュメント化されていないコンパイラ挙動でしか動かなかったため、このパッケージはその推論を実装しません。

fixture は step と同じ方法で第一引数を分割代入します。
`check` は fixture を呼ばずに、ソーステキストから fixture の依存名を読みます。
step の依存も同じ方法で読みます。
fixture は builtin の依存として `page`、`context`、`request`、`env`、`requireEnv`、`baseURL` を名指せます。
fixture は別の `config.fixtures` エントリも名指せます。
解決は Playwright の `extend()` モデルに従うため、後の層は前の層に依存できます。
したがって、fixture は別の fixture に依存でき、その fixture は builtin に依存できます。

fixture は builtin を上書きできます。
たとえば、`page` fixture は executor が起動するページを包めます。
(`page: async ({ page }, use) => { page.setDefaultTimeout(10_000); await
use(page); }`)。
この場合、依存の `page` は下層の builtin を指します。
上書きする fixture 自身は指さないため、この依存は循環ではありません。
`page` も `context` も分割代入しない上書きは、executor が引き続き所有して計測するページを返せません。
したがって、`check` は `page-override-unowned` で拒否します。

スコープは 2 つあります。
既定の `scenario` スコープは、scenario ごと、または `nuka do` の実行ごとに fixture を再構築します。
その scenario または実行の終わりに fixture を teardown します。
`process` スコープは、`nuka run` の実行中に step が最初に名指した時点で fixture を構築します。
step は直接、または別の fixture を通じて名指せます。
nukadoko は、その実行のすべての scenario が終わったあとに fixture を teardown します。

nukadoko はまだ scenario を並列実行しないため、`worker` スコープは存在しません。
現在の `worker` は `process` と同じ意味になります。
`nuka do` では、1 回の実行に両方の完全な寿命が含まれます。
したがって、このコマンドでは `process` fixture は `scenario` fixture と同じように動きます。

`process` fixture が依存できるのは、別の `process` fixture と、`env`、`requireEnv`、`baseURL` の 3 つの builtin だけです。
これらの builtin の値は scenario context に依存しません。
`fixture-scope-violation` は、`page`、`context`、`request`、`resultOf`、`call`、`section`、`poll`、`evidence`、`scenario` fixture への依存を拒否します。
`process` fixture は、これらの値を供給する scenario より長く生きる場合があります。

`process` は 1 つのアドレス空間を指します。
1 回の `nuka run` 実行を指すものではありません。
fixture の値は素の JavaScript オブジェクトであり、別のプロセスへ渡せません。
したがって、このスコープは常に「プロセスごとに 1 回」を意味します。
現在は 1 回の `nuka run` 実行が 1 つのプロセスを使うため、2 つの寿命は一致します。
このスコープは、その一致を保証しません。
世界で正確に 1 回だけ実行する必要がある処理に `process` fixture を使わないでください。
例には、データベースのシード、マイグレーション、ポートを所有するモックサーバがあります。
プロセスを追加するたびに、その処理が再び実行されます。

step の成否にかかわらず、teardown は構築の逆順を使います。
step の失敗によって fixture の片付けが省略可能になることはありません。
nukadoko は fixture の構築と teardown を**直列に**行うため、この逆順は正しく機能します。
setup と teardown が直列である間、逆順によって各依存はその依存先より長く生きます。
並列実行は、この規則を静かに無効にします。
別の fixture が依存を使う前に、1 つの scenario がその依存を teardown する場合があります。
原因が fixture グラフの形ではなくタイミングにあるため、`check` はこのレースを検出できません。
並列実行の実装では、最初にこの teardown 規則を改める必要があります。

setup は、その fixture を名指した step の成否を知ることができません。
`process` スコープでは、setup は run の成否を知ることができません。
したがって、fixture 関数は成否を第二引数として受け取りません。
代わりに、`use()` が成否を返します。

```ts
tenant: async ({ request }, use) => {
  const t = await createTenant(request);
  const outcome = await use(t);          // "passed" | "failed"
  if (outcome === "passed") await destroyTenant(request, t);
},
```

QA では通常、失敗したテナントを調査用に残し、成功したテナントを破棄します。
Playwright の `afterEach` も同じ理由で `testInfo.status` を読みます。
teardown の失敗は step または scenario の成否を変えません。
片付けのエラーは、受け入れ条件の外にある理由で、本来成功する run を失敗にできません。
ただし、nukadoko は teardown の失敗を必ず報告します。
`scenario` fixture の失敗は、scenario record の `teardown_errors` に入ります。
`process` fixture の失敗は、すべての scenario が終わったあとに stderr へ出ます。
そのプロセス単位の失敗を格納できる単一の scenario record はありません。
`nuka run` と `nuka do` はどちらの失敗も通知しますが、exit code は変わりません。

fixture は `use(value)` を正確に 1 回呼ぶ必要があります。
この呼び出しの前に関数が完了すると、nukadoko は fixture 名を含むエラーを投げます。
関数が 2 回呼ぶと、nukadoko は 2 回目の呼び出しで fixture 名を含むエラーを投げます。
これらのチェックは、`ctx.page()` には存在しなかった状態を扱います。
fixture は、nukadoko が `use()` で中断し、teardown 中に再開するコルーチンです。
最初のチェックがないと、`use()` に到達しない fixture が run を永遠に止める場合があります。

setup と teardown は、それぞれ別のタイムアウト予算を受け取ります。
`config.fixtureTimeout` は既定の予算を 60 秒に設定します。
fixture は `options.timeout` で上書きできます。
タイムアウトの報告は fixture と局面の両方を名指します。

`check` は fixture を実行せずに、fixture に関する 3 つの所見を報告します。
`fixture-cycle` は、`config.fixtures` エントリ間の依存循環を特定します。
`fixture-scope-violation` は、`scenario` fixture に依存する `process` fixture を特定します。
`page-override-unowned` は、上で説明した無効な `page` の上書きを特定します。

`tend` は 2 つの事実を追加で報告します。
`fixture-unused` は、直接にも別の fixture 経由でも、どの typed step も要求しない `config.fixtures` エントリを特定します。
そのエントリには `nuka do` から引き続き到達できます。
`fixture-touches-app` は、直接または別の fixture 経由で `page` か `context` に到達する fixture を特定します。
ブラウザ fixture は、名指されていない前提条件によって scenario を成功させる場合があります。
たとえば、どの step もログインを要求する前にユーザーをログインさせられます。
これは、step の Given が説明しない作業と同じ効果を持ちます。
この報告は、fixture からのブラウザアクセスを禁止しません。
たとえば、fixture は正当な目的で `storageState` を生成できます。
`tend` は fixture を特定するだけであり、各 fixture がそこに属するかは読み手が判断します。

リストが空でない場合だけ、step record は `fixtures` を含みます。
このリストには、その実行で fixture の解決が触れたすべての `config.fixtures` エントリが入ります。
各エントリは `{ "name", "scope", "setup_ms"?, "at"?, "reused" }` を持ちます。
`setup_ms` と `at` は、この呼び出しが fixture のインスタンスを構築した場合だけ存在します。
`reused: true` のエントリでこれらがないことは、そのインスタンスがすでに存在したことを意味します。
この区別により、再利用と、計測された setup 時間が 0 ミリ秒だった場合を区別できます。

「Context API」の説明どおり、`nuka steps --json` の `needs` と `needs_browser` は推移的な fixture 依存を含みます。
たとえば、step が `page` に到達する fixture だけを分割代入する場合があります。
その `needs` 配列はその fixture だけを名指しますが、`needs_browser: true` も持ちます。
`needs: null` の step には、展開する依存リストがありません。
したがって、そのエントリには `needs_browser` もありません。
「Context API」の説明どおり、`needs_inferred` は引き続き含まれる場合があります。
そのフィールドは契約ではなく、字句上の推測です。
nukadoko は `needs_inferred` を fixture グラフ全体へ展開しません。

### MCP servers

2 つのインターフェースが、stdio 経由で標準的な MCP サーバに到達します。
どちらのインターフェースも `nuka steps` から分離されています。
`nuka mcp-tools -- <command> [args...]` は、サーバが宣言したツールを読み取って出力します。
`"nukadoko/mcp"` の `connectMcpServer` と `callMcpTool` により、手書きの step がツールを呼べます。
宣言されたツールは、人が step の `args` を手で書くために役立ちます。
このパッケージは、宣言されたツールを step または step 語彙に変換しません。
`nuka steps` は MCP ツールを一覧にせず、これらのインターフェースも MCP ツールを生成しません。

fixture がサーバプロセスの寿命を制御します。
`nukadoko.config.ts` には MCP 専用のフィールドがありません。
fixture の機構が、setup、teardown、`scenario` または `process` のスコープをすでに提供します。
fixture は setup 中に `connectMcpServer` を呼び、teardown 中に `client.close()` を呼びます。
fixture のスコープによって、scenario ごとの接続か run ごとの接続を選びます。
2 つのサーバを同時に使う場合は 2 つの fixture を使い、機構は変わりません。

`connectMcpServer` は、client パッケージの stdio パラメータを変更せずに受け取ります。
第二引数には、そのパッケージの `ClientOptions` も渡せます。
この関数は、そのパッケージの接続済み `Client` を返します。
この薄いインターフェースは、`ctx.page()` と `ctx.request()` が Playwright に対して採る方針に従います。

`ClientOptions` の `versionNegotiation` フィールドが MCP プロトコルの世代を選びます。
呼び出し側が省略すると、client パッケージは既定の動作を使います。
その動作は、probe と新しいヘッダを使わない、通常の 2025 年版接続手順です。
`{ versionNegotiation: { mode: 'auto' } }` モードは、最初に `server/discover` probe を送ります。
サーバが modern な版を報告しない場合、client は 2025 年版の手順を使います。
stdio では、各 probe が接続ごとに短命の sibling process を 1 つ追加で起動します。
client はプロトコルの世代を判定したあとに、そのプロセスを破棄します。
したがって、`'auto'` モードの fixture setup は、毎回プロセスを 1 つ追加で起動します。

pin モードの `{ mode: { pin: '<version>' } }` はフォールバックを使いません。
サーバが指定された版を提供しない場合は失敗します。
`connectMcpServer` は `ClientOptions` を `Client` のコンストラクタへ直接渡します。
この関数はオプションを読まず、上書きもしないため、呼び出し側がプロトコルの世代を選びます。

`callMcpTool` は、直接のインターフェースに 1 つの動作を加えます。
MCP はツール内の失敗を、`isError: true` を持つ成功レスポンスとして返します。
その失敗では Promise を reject しません。
確認がなければ、step は失敗した呼び出しを成功した呼び出しとして記録する場合があります。
`callMcpTool` は `isError` が true の場合に throw し、その他の結果フィールドを変更せずに返します。

### WebMCP tools(実験的)

3 つ目のインターフェースは、宣言されたツールを読み、`nuka steps` から分離したままにします。
「MCP servers」のインターフェースも、stdio サーバに対して同じ分離を行います。
WebMCP は異なるプロトコルとインターフェースを使います。
WebMCP は、ページが JavaScript から `navigator.modelContext.registerTool` を通じてツールを宣言するブラウザ標準です。
プロジェクトは、これらのツール用に別の接続を開きません。

`nuka experimental webmcp-tools <url>` は、設定済みの新しいブラウザを起動して `url` に移動します。
session の復元も evidence の収集も行いません。
ページがすでに宣言したツールを読み、レポートを出力します。
そのレポートが step 語彙になることはありません。
`nuka steps` はこのインターフェースを読まず、このインターフェースも step discovery を読みません。
この分離により、ページがプロジェクトの step 語彙の一部を選ぶことを防ぎます。
固定された語彙は、生成された実装から受け入れ条件を保護します。

手書きの typed step は、`"nukadoko"` から `experimental_callWebmcpTool` を import し、宣言済みツールを名前で呼べます。

`experimental_callWebmcpTool` は fixture bag のメンバーではなく、素の import です。
executor が注入するのは、fixture が運ぶ必要がある値だけです。
この関数が必要とするのは `page` だけであり、step はすでに fixture として受け取ります。

`poll` は別の理由で import から fixture bag へ移りました。
記録がなければ、完了した待ちは step record 上で最初の試行の成功と同じに見えます。
`poll` fixture はその計測の隙間を埋めます。
WebMCP ツールの呼び出しには、同じ隙間がありません。
その typed step が `args` と `returns` の schema を宣言します。
step が値を生成した方法にかかわらず、run の境界がこれらの schema をバリデーションします。
したがって、この関数が追加の記録を書かなくても、step record は戻り値を含みます。

WebMCP ツールの呼び出しは信頼境界を越えます。
ページはテスト対象であり、信頼できる相手ではありません。
`args` を受け取るコードはページが宣言し、このプロジェクトは提供しません。
`args` は JSON としてページに入り、ページの JavaScript が読みます。
たとえば、step は `ctx.requireEnv` を通じて機微な値を読めます。
その値を `args` に入れると、テスト対象のページへ渡します。
`experimental_callWebmcpTool` を通じて機微な値を渡さないでください。

両方のインターフェースは、実行時フラグではなく名前で実験的という印を示します。
関数は `experimental_` 接頭辞を使います。
補完が step の書き手に関数を提示するときも、接頭辞は見えます。
CLI は `experimental` を `webmcp-tools` の 1 段上のコマンドに置きます。
どちらのインターフェースを使う場合も、呼び出し側はその印を入力する必要があります。

この命名は「MCP servers」のインターフェースと異なります。
MCP は主要なプロトコルの名前であるため、`nuka mcp-tools` はトップレベルのコマンドに留まります。
WebMCP は補助的なプロトコルであるため、そのコマンドは 1 段深くなります。
したがって、WebMCP の各 CLI 呼び出しは `experimental` を含みます。

標準のドキュメントがこの利用方法を明確にサポートしていないため、この印は残ります。
Chrome の WebMCP ドキュメントは、2026-08-13 に https://developer.chrome.com/docs/ai/webmcp から取得しました。
そこには、headless での利用は動く可能性があるものの、API は主に人が関与するローカルのブラウザ作業を対象にするとあります。
標準は引き続き活発な議論の対象であり、変更される可能性があるとも書かれています。

同日に取得した日本語ページは、英語ページより強い主張をします。
そこには、JavaScript のツール呼び出しには、目に見えるインターフェースを提供する開いたブラウザタブか webview が必要だとあります。
そのため、agent または補助ツールからの headless 呼び出しをサポート対象外と説明します。
`experimental_callWebmcpTool` は、Node から Playwright を通じてこの種類の呼び出しを行います。
2 つの言語版は、同じ日にサポートについて食い違っていました。
この食い違いにより、印のない依存は安全ではありません。
テストは、現在 Chromium 149 でインターフェースが動くことを確認しています。
その計測は、動作の継続を保証しません。

関数とコマンドから実験的という印を外すには、2 つの条件が必要です。
第一に、公式ドキュメントが補助的または headless な呼び出し側を明示的にサポートする必要があります。
第二に、標準が変更される可能性があるという説明をやめる必要があります。
1 文が削除されただけでは、どちらの条件も満たしません。
言語版のページは、文の欠落だけでは現在の主張を特定できないことをすでに示しています。

### step の連鎖

CLI 専用の step は `pattern` を持たず、単独で実行されます。
`pattern` を追加すると scenario に束ねられ、新しい問いが生じます。
その step には、以前の step から値を受け取る方法が必要です。

すべての値を `resultOf` で読むと、コマンドライン引数がなくなります。
その場合、step は `nuka do` による単独実行を失う可能性があります。
その実行により、語彙が agent にとって有用になります。
複合 step は既存の step を保ちますが、1 つの Given の行の背後に作業を隠します。
feature ファイルは、その作業を読み手に示さなくなります。

`from` はキーの供給元をデータとして宣言し、両方の性質を保ちます。

```ts
import { defineStep, z } from "nukadoko";
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

pattern の capture は `from` より優先されます。
`from` は、この step の出現がキャプチャしなかったキーだけを供給します。
したがって、ある scenario は Gherkin の行で値を供給できます。
別の scenario は、以前の step から同じ値を供給できます。
`from` は、現在の scenario でその step が直近に成功した結果を使います。
両方が同じ連鎖を使うため、この結果の寿命は `resultOf` と同じです。
nukadoko は `args` をバリデーションする前に値を注入します。
したがって、キーは **required** のままであり、`args` は step の要求を引き続き表します。
呼び出し側が値を供給する方法は表しません。

キーは複数の生産者候補を名指せます。
たとえば、scenario はプロジェクトを作成するか import できます。
消費側は、これらの供給元を支えるために 2 つの step を必要としません。

```ts
from: { projectId: [[createProject, "id"], [importProject, "projectId"]] }
```

生産者候補に優先順位はありません。
最初の一致、宣言順、step 間の新しさに関する規則はありません。
代わりに、チェックは scenario 内の先行する生産者候補を **正確に 1 つ** 要求します。
生産者が 0 個なら、既存の生産者不足エラーが起きます。
生産者が 2 個以上でもエラーが起きます。
nukadoko は、読み手から見えない規則に依存する scenario を拒否します。
feature ファイルが、出現ごとに生産者を特定します。
step は既定の生産者を指定しません。

同じ生産者が繰り返される場合は、別の規則に従います。
`Given a project is created` が消費側の前に 2 回現れると、消費側は最新の結果を使います。
両方の出現は同じ契約を持つため、異なるのは結果の鮮度だけです。
2 つの異なる生産者は異なる契約を持ち、provenance の選択を生じさせます。
鮮度には直近という既定値が適しますが、provenance には適しません。

生産者候補は相互排他的であり、正確に 1 つを実行する必要があります。
代わりに、scenario は両方の生産者を実行し、1 つの record への 2 経路を比較できます。
その場合は、生産者ごとに別のキーを割り当てます。

```ts
from: {
  createdId:  [createProject, "id"],
  importedId: [importProject, "id"],
}
```

両方のキーが束ねられ、両方の値が競合せずに読まれます。
1 つの scenario で 2 つの生産者が走る場合、1 つの消費側キーでは両方の値を表せません。
消費側は、2 つの値に 2 つのキーを宣言する必要があります。

`from` が selector 関数ではなくキー名を使うのは、名前がデータだからです。
`nuka steps --json` と `nuka describe` は、それを「`projectId` ← `createProject.id`」として保持します。
agent はそのデータを使い、教えられていない順序を組み立てられます。
`nuka check` も、そのデータを使って実行前に scenario を評価します。
関数はより多くの動作を表せますが、ツールは供給元の step だけしか報告できません。
結果から選んだ部分は報告できません。
この設計では、キーで参照できる `returns` の形が必要です。
この小さなコストにより、step も読みやすくなります。

`from` の宣言により、確実な静的チェックが可能になります。
各 step の出現について、`nuka check` は最初に Gherkin の行が各宣言済みキーをキャプチャするか調べます。
行がキーをキャプチャしない場合は、同じ pickle 内の先行する生産者を調べます。
pickle は Background の step を含みます。
`nuka run` は scenario を実行する前に同じチェックを行います。
したがって、`nuka check` を省いてもブラウザセッションを無駄にしません。

先行する生産者がない **required** なキーはエラーです。
run は必ず `args` のバリデーションに失敗するため、このチェックは偽陽性を作りません。
生産者がない **optional** なキーは、schema が欠落を許すため所見を出しません。
その場合の警告は、有効な契約を問題として報告します。
先行する生産者が 2 つ以上なら、required と optional のどちらのキーでもエラーになります。
optional な schema は欠落を許しますが、複数の生産者から 1 つを選びません。
`from` より前は、生産者より先にある消費側も、ブラウザ実行でエラーが出るまで有効に見えました。

`from` と `resultOf` は、名前ではなく `Step` オブジェクトで上流の step を識別します。
`await import()` で読み込んだ step は、discovery が登録したインスタンスとは別のインスタンスです。
したがって、そのオブジェクトは登録済み step に一致しません。
以前は、この誤りに対して `resultOf` が `undefined` を返し続けました。
現在は、未登録の `Step` が見つかった場所でエラーになります。
`from` はオブジェクトを静的に宣言するため、`nuka check` が報告します。
`nuka run` と `nuka do` も、その step の実行を拒否します。
`resultOf` は実行時にオブジェクトを選ぶため、呼び出し時に throw します。
まだ実行されていない登録済み step は、現在の状態を表す `undefined` を引き続き返します。

`from` で必要な読み取りを表せない場合は、`resultOf` を使います。
該当するのは、値の変形、実行時に決まる読み取り、結果全体の利用です。
step を単独でも実行する必要がある場合は、引数を optional にし、`run` 内にフォールバックを追加します。
この古い形は現在では例外です。

`nuka do` には scenario がないため、連鎖もありません。
`from` のキーは、他の引数と同様に `--args` から受け取れます。
「単体 step」で説明するとおり、`--use` を通じて以前の実行の step record から受け取ることもできます。
両方の経路は同じ step 契約を使い、値の供給元だけが異なります。

`from` は上流の step を実行しません。
scenario に生産者がなければ feature ファイルを直します。
feature は実行されたすべてを名指す必要があるため、nukadoko は生産者を挿入できません。
挿入すると、feature は必要な実行記録を提供しなくなります。

この規則により、識別子を渡すだけの scenario 行が生じる場合があります。
たとえば、`And the project's billing page is fetched` は feature の読み手に価値を持たない場合があります。
読み手に価値がない操作を step にしないでください。
契約がない場合は、`features/steps/lib/` の普通の関数にします。
次の節の説明どおり、契約がある場合は part にします。
step の書き手は、場合ごとに record の詳細度と feature の読みやすさを調整します。

step の連鎖は、`mutates` とは異なる方法で宣言と計測を結び付けます(「キーワードの意味論」を参照)。
`mutates` では、HTTP メソッドは書き込みの意味論を表すプロキシにすぎません。
したがって、ツールは宣言と計測を突き合わせずに記録します。
step の連鎖では、nukadoko は値を供給した正確な step record を知ります。
`from` は実行を制御するため、その宣言が実行された供給元 step と異なることはありません。
したがって、この場合は突き合わせが不要です。
step record の `used` フィールドは宣言をチェックしません(「Records」を参照)。
宣言は、書き手がファイルを書く時点で供給元 step を特定します。
`used` は、実行時に供給元の具体的な実行を特定します。

### Parts

step は、読み手が scenario を理解する粒度で書きます。
他のコードが再利用に同じ粒度を必要とすることは、ほとんどありません。
この不一致は通常、2 つ目の scenario が現れたときに 2 つの形のどちらかで現れます。
正しい step が具体的すぎる場合があります。
それを一般化する変更では、pattern が捉える `args` キーを追加し、既存の契約チェックがこの変更を扱います。
別の形では、step が 2 つの操作を実行しますが、新しい scenario は片方だけを必要とします。
必要な操作には、名前、契約、呼び出し可能なインターフェースがありません。

step を分割して最初の scenario を書き換えると、合意済みの record が変わります。
ソフトウェアの目的を決める人たちはその feature に合意しており、feature はすでに sign-off を持っているかもしれません。
実装のリファクタは、合意済みの文を維持する必要があります。

代わりに、step は別の step を呼び出せます。
`parts` は呼び出す step を宣言し、`call` fixture がその 1 つを実行します。

```ts
import { defineStep, z } from "nukadoko";
import createProject from "./parts/create-project.js";
import inviteMember from "./parts/invite-member.js";

export default defineStep({
  pattern: "a project named {string} has {string} as a member",
  description: "Create a project and invite one member into it",
  args: z.object({ name: z.string(), email: z.string() }),
  returns: z.object({ projectId: z.string(), memberId: z.string() }),
  parts: [createProject, inviteMember],
  async run({ call }, args) {
    const project = await call(createProject, { name: args.name });
    const member = await call(inviteMember, {
      projectId: project.id,
      email: args.email,
    });
    return { projectId: project.id, memberId: member.id };
  },
});
```

part は 2 つ目の種類の単位ではありません。
part は同じ `defineStep` を使う `Step` であり、別の step が宣言することで part になります。
呼び出し専用の part は `pattern` を省略します。
その part は、既存の CLI 専用の語彙に残ります。
`nuka do create-project` は part を単体で実行し、`nuka steps` は part を一覧します。
したがって、part は scenario が名指す前から到達可能であり、読み取れます。
あとから `pattern` を追加すると、既存の呼び出しを維持したまま part を scenario の行に束ねられます。
2 つ目の scenario は、最初の feature ファイルを変えずに細かい粒度を使えます。
2 つの粒度は共存します。

executor は `run()` を呼ぶ前に fixture bag を構築するため、`parts` を宣言する必要があります。
executor は第一引数が分割代入する名前を静的に読みます。
part は同じ bag から自分の名前を分割代入します。
したがって、いずれかの part が `page` を使う場合、呼び出し元の bag に `page` が必要です。
executor は、どちらの関数も動く前にこの決定を下します。
`call` の呼び出し箇所を調べるパーサは、制御フローを推測する必要があります。
そのパーサは、分岐内の呼び出しを見落とす可能性があります。
宣言は、答えをデータにします。
step は、自分の fixture 名と、推移的に宣言されたすべての part の fixture 名を必要とします。
ユーザー定義 fixture も、同じ方法ですでに必要なものを閉じています(「Fixtures」を参照)。
この規則には、目に見えるコストがあります。
いずれかの part が `page` を使う場合、複合 step は、その part を呼ぶ分岐を run が通らなくてもブラウザを開きます。
この規則は、実行前には分からない決定によって step の途中でブラウザが開くことを防ぎます。

`from` と同様に、名前はデータです。
`nuka steps --json` と `nuka describe` は `parts` を保持します。
agent はファイルを開かずに、1 つの step が他の 2 つの step を含むことを確認できます。
`nuka check` は、実行前に同じ宣言を調べられます。
`call` は、`parts` が宣言していない step を拒否します。
また、discovery が登録しなかった step も拒否します。
`resultOf` は後者のエラーをすでに拒否します。
2 回目の `await import()` は、登録済みの語彙と一致しないオブジェクトを作ります。
これらのチェックが宣言の正確さを保ちます。

呼び出し元の step は、各呼び出しを自分の step record の `calls` に記録します。
呼び出しは、別の step record を作りません。
scenario record は、feature の各行に対して 1 つの `steps[]` エントリを維持します。
feature は実行されたすべてを名指し続け、part はその行の下に詳細を加えます。
各 call エントリは、part 名、args、result、開始時刻、終了時刻を含みます。
失敗したエントリは、step record の `error` と同じ分類の error も含みます。
executor は、他の step と同じ方法で part の `args` と `returns` をチェックします。
part から別の part への呼び出しは、同じ入れ子構造を使います。

step の境界にある計測は分割されません。
`observed`、`sections`、`used`、`required_env`、evidence directory、trace chunk は、呼び出し元の step に属します。
それらの合計には、すべての part の作業が含まれます。
part は、呼び出し元の `ctx` も共有します。
record は、1 回の実行を詳しく記述します。
1 つの合計によって重複した計測を防ぎ、part 内で実行された作業も計測に含めます。

`call` は `from` を参照しません。
呼び出し元は、`nuka do` と同様にすべてのキーを渡します。
連鎖は scenario に属しますが、呼び出しは scenario に属しません。
part が scenario の行としても実行される場合、その出現は part の `from` を使います。
1 つの呼び出し元の入力は、他の呼び出し元に影響しません。

`nuka check` は、確定できる 2 つのエラーを報告します。
1 つ目は、step が自分自身に到達する `parts` の循環です。
この循環からは、閉じた fixture bag も終了する run も作れません。
2 つ目は、宣言した part が `mutates: true` なのに、step が `mutates: false` を宣言することです。
`mutates` は、part を含めて step が到達できるすべての場所での状態変更を扱います。
このチェックによって `then-mutates` は局所的なままです。
`Then` の行は、1 つの step にある 1 つのフラグを引き続き読みます。
そのフラグは、すでにすべての part を考慮しています。

本体が一度も呼ばない宣言済みの part を報告するチェックはありません。
呼び出しは `run` にありますが、宣言は `Step` オブジェクトを名指します。
宣言は、本体がそのオブジェクトに束縛した識別子を名指しません。
したがって、チェックは名前が対応するかを推測する必要があります。
また、本体は 1 つの分岐だけで part を呼ぶことがあります。
使われていない `from` キーは、feature ファイルに判定可能な情報があるため別です。
`nuka tend` はその場合を報告します。
利用できる静的データからは、part が使われていないかを判定できません。

矛盾チェックは、読み取り専用ポリシーを強制しません。
読み取り専用 environment では、`call` が `mutates: true` の part を実行前に拒否します。
呼び出し元の宣言は、この拒否を変えません。
静的チェックは、より早く低いコストで矛盾を見つけます。
静的チェックが実行されなかった場合は、実行時の拒否が実行を保護します。
どちらの制御も、part の宣言を信頼します。

「step の連鎖」の軸を広げて、ヘルパー、part、step から選びます。
操作が scenario の読み手にとって意味を持つ場合は、step にします。
acceptance record は、その step record を含みます。
それ以外の場合は、失敗の record が示すべき内容を検討します。
操作に有用な契約、入力、result がある場合は、part を使います。
いずれもない場合は、`features/steps/lib/` の下にある通常の関数を使います。
ヘルパーには、独立した record エントリがありません。
その HTTP 呼び出しは呼び出し元の step の `observed` に引き続き加わり、`section` は実行の進行を示せます。
たとえば、payload を整形する関数や fixture ファイルを選ぶ関数には、通常、保存する価値がある契約や result がありません。
この関数を part にすると、維持する schema だけが増えます。

1 つの代替案を却下しました。
step ファイルは、named export を使って複数の step を export できます。
この設計では、分割した操作を複合 step の隣に置けます。
しかし、型付き step の名前は、import をせずにファイル名から補完されます(「実装ノート」を参照)。
この性質によって、語彙が増えても TAB は高速に動きます。
CLI は、named export があるファイルを import しなければ、その export を認識できません。
part ごとにファイルを分けると、高速な補完を維持し、ファイルが 1 つ増えます。

### キーワードの意味論

Gherkin のキーワードが事実を運ぶのは、nukadoko が **`mutates` の宣言**を信頼するためです。
ツールは、実行からこの事実を再度導いたり、矛盾する宣言を上書きしたりしません。
実際のスイートには、次の層が必要です。
同じ文が、Action と Outcome の両方の位置に正しく現れることがあります。
スイートは、`Then` のあとに `And` で操作を連ねることがよくあります。
任意のコマンドをラップする step は、すべての出現に対して 1 つの正確な `mutates` 値を持てません。
したがって、step ごとの boolean は出現ごとの事実を記述できません:

- `mutates` は step の**宣言された意図**を示します。
  デフォルトは `true` であり、読み取り専用の step は `false` を宣言します。
- **静的解析では**、宣言上 mutate する step が Then の位置に結び付けられていると、`nuka check` が警告します。
  エラーは報告しません。
  宣言だけでは矛盾を解決できないため、人がレビューする必要があります。
- **読み取り専用の environment は、宣言上 mutate する step を実行前に拒否します。**
  この規則には、`call` を経由して到達した part も含まれます(「Parts」を参照)。
  宣言が実行をゲートする場所は、ここだけです。
- **実行時には**、step record が実行内容を保存します。
  ツールが `request` fixture または page を通じて観測した、すべてのネットワーク呼び出しを保存します。
  GET/HEAD 以外の呼び出しを観測された書き込みとして数え、宣言された `mutates` 値の隣に置きます。
  この回数は、Then の位置も、読み取り専用 environment のポリシーも決めません。
  nukadoko は、`observed` の値にかかわらず `mutates: false` を信頼します。
- Gherkin は、`And` または `But` の step を、直前の主要キーワード(Given、When、Then)の pickle step type で分類します。
  Gherkin の pickle コンパイラが、この挙動を定義します。
  したがって、`Then` のあとの操作は、その位置にある他の step と同じ Then 位置の観測を受けます。
  その位置は、操作をゲートしません。
- 計測では、この事実を決められません。
  書き込みの検出は HTTP メソッドを使い、GET/HEAD 以外の各 request を書き込みとして数えます。
  HTTP メソッドは、書き込みの意味論を示すプロキシです。
  GraphQL、RPC-over-POST、多くのベンダー query API は、意味的に純粋な読み取りに POST を使います。
  呼び出しがサーバの状態を変えるかは、外部システムが定義します。
  nukadoko が観測するのは、その下にある HTTP レイヤーだけです。
  各プロトコルは、読み取りと書き込みを区別するために異なるデータを使います。
  たとえば、GraphQL body の `query` または `mutation`、RPC のメソッド名、ベンダーの path 規約です。
  汎用の機械的な規則では、この区別を判断できません。
  回数は、step が送ったものを保証します。
  サーバの状態が変わったことは保証しません。
- record は、すべての計測を保持します。
  `observed`、http.jsonl、Allure の declared/observed テーブルは変わりません。
  したがって、読み手は実行後にそれらを使って誤った宣言を反証できます。
  この境界は、mutation の意味論に対するツールの権限が終わる場所を示します。
- nukadoko は、この比較を実行しません。
  運用者は、別の artifact を使わずに、同じ step record にある `mutates` と `observed` を比較できます。
  しかし、`nuka run` と `nuka check` は、これらの値が矛盾すると主張しません。
  その主張は、HTTP メソッドのプロキシを確定した事実として扱います。
  GraphQL の読み取り、RPC-over-POST の読み取り、ベンダー API の POST による読み取りを、すべて偽陽性として報告します。
  同じ理由で、nukadoko は実行時に mutation の意味論を強制しません。
  `nuka accept` の record だけが、この比較を書き出します(Sign-off を参照)。
  sign-off では、人がすでに run を読み、判断します。
  そこで record は、`nuka run` または `nuka check` の呼び出しごとに偽陽性のノイズを加えず、生の事実を示せます。
- Compat(型のない)step には、`mutates` の宣言がありません(「compat step に欠けているもの」を参照)。
  `nuka check` の `then-compat-step` 警告は、compat step が Then の位置に結び付けられたときに、このカバレッジの欠落を示します。
  mutation の矛盾は示しません。
  実行時の観測は他の step と同じ回数を記録しますが、その回数は何もゲートしません。

## Compat steps(移行の扉)

既存の Cucumber と Playwright のスイートは、import を 1 つ変更して nukadoko を導入できます:

```ts
// before: import { Given, When, Then } from "@cucumber/cucumber";
import { Given, When, Then } from "nukadoko/compat";
```

- Compat step は既存の pattern 構文と World(`this`)を維持します。
  nukadoko の harness が `page` と `request` を提供し、管理します。
  カスタム World クラスは、`setWorldConstructor` を使って nukadoko の基底クラスを拡張します。
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
  `nuka check` は support 由来の登録を警告として列挙します。
  config が、それらの引退先です。
- 実行は 2 つの形をサポートします。
  自前で Playwright を起動する glue は計測されないまま動き続けます。
  `await this.openPage()` と `await this.openRequest()` は、harness の計測対象である page と request を返します。
  混在 scenario の typed step は、同じ context と cookie を共有します。
  table は依存ゼロの薄い `DataTable`(raw / rows / hashes / rowsHash / transpose)として届きます。
  `table.hashes()` を呼ぶ glue が import の差し替えで壊れてはならないからです。
  docstring は素の string のままです。
  Before / After hook は、cucumber-js が受け付ける 3 つの書き方をサポートします。
  その書き方は、`Before(fn)`、`Before({ tags }, fn)`、`Before("@tag", fn)` です。
  hook は cucumber 自身の hook 引数を受け取ります。
  hook は `@tag` または `not @tag` だけで絞り込めます。
  より複雑な式は、静かな誤マッチを防ぐために明示的に失敗します。
  hook は自分の step record を持たず、scenario record の `hooks` 配列に現れます。
  hook 内のネットワーク通信は、どの step の境界にも属しません。
  http.jsonl と observed の読み書きカウントは scenario 全体で共有され続け、個々の hook 呼び出しに紐付けられることはありません。
  ただし Playwright の trace は違います。
  `this.openPage()` に触れた Before/After/AfterStep の個々の呼び出しは、それぞれ自分自身の trace chunk と `actions` のリストを持ち、同じ `hooks` 配列のエントリ上に記録されます。
  `trace`/`actions`/`truncated` は、step 自身の record と同じ形です(「Records」を参照)。
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
  Allure と cucumber-messages の両方の emitter がこれをそのまま運びます。
  hook 引数の `result.status` は、`@cucumber/messages` の `TestStepResultStatus` 文字列値を使います。
  `nukadoko/compat` は、同じ enum を `Status` として re-export します。
  したがって、`result.status === Status.FAILED` と書かれた glue は正しく import され、比較できます。
  この enum の他のメンバー(`PENDING`/`SKIPPED`/`UNDEFINED`/`AMBIGUOUS`)は決して一致しません。
  nukadoko には、hook 自身の result が運びうる pending、skipped、undefined-step、ambiguous-match のいずれの概念もないからです。
  移行した glue は、これらの値を比較する分岐を通らず、この挙動は compat gap ではありません。
  `BeforeAll`/`AfterAll` は、scenario ではなく run 全体を挟みます。
  tags を受け取らず、World を持たず、scenario が 1 つも選ばれなければ実行されません。
  これらの hook は scenario record に属さないため、exit code を通じて報告します。
  `setDefaultTimeout` は、自分の timeout を宣言していないものすべてに既定値を与えます。
  呼ばずにおけば、step は cucumber の 5 秒という上限を持ち込む代わりに無制限のままになります。
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
- harness はブラウザと request のオブジェクトを所有します。
  したがって、compat step はコードを変更せずに計測済みの step record を得ます。
  この record は status、timing、trace、screenshots、HTTP log を含みます。
- compat step には、型付きの契約、step record 内でバリデーションされた `result`、単体 step の CLI 実行がありません。
  よく使う step を `defineStep` に昇格させると、これらの性質を 1 step ずつ追加できます。
- 監査によって、この扉の幅を計測しました。
  公開されている cucumber-js のスイート 8 本を、この扉に対して監査しました。
  glue はテキストとして読み、実行しませんでした。
  当時はどのスイートも import の差し替えだけでは通りませんでしたが、そこで見つかった障害をふさいだことで、8 本のうち 2 本はその後、glue の中に拒まれるものが何もない状態になりました。
  残りが何を必要とするかは [docs/migration.ja.md](migration.ja.md) に列挙されています。
  監査から 1 つの規則を定めました。
  compat がサポートしない挙動は、import 時または最初の run で失敗する必要があります。
  移行するチームは、大きな声の失敗には対処できますが、静かな失敗は見えません。
  だから、黙って振る舞いを変えてしまう抜けは、機能が欠けていることが食ってきた時間よりも多くの信頼を食います。
- 明示的な失敗は、静的な所見と step の実行が必要な失敗に分かれます。
  `nuka check` は、静的な所見だけを報告します。
  **`nuka check` が報告できる失敗**: import が例外を投げる step ファイルは `step-file-import-failed` エラーになります。
  原因には、`nukadoko/compat` が export しない名前の値としての使用、ESM glue 内の CommonJS `require`、深い subpath の import があります。
  単一の `@tag` / `not @tag` を超える hook のタグ式は、`unsupported-hook-tag-expression` エラーになります。
  どちらも、何かが実行される前に、そのファイルのテキストだけから分かります。
  その隣にはさらに 2 つの所見があり、どちらも 1 つのファイルの中身についてではなく discovery 自身が歩く範囲についてのものです。
  `.cjs` ファイルが `featuresDir` の下にあるときの `step-file-unsupported-extension`(nukadoko がそれを import しない理由は前述の「型付き step」を参照)と、歩いた結果として試せるものが何もなかったときの `no-step-files-found` です。
  どちらも、実際に何を見た結果なのかを名指しします。
  これは、`nuka tend` 自身の `scanned:` 行が従っているのと同じ「所見が嘘のとき、それに気づけるように」という論拠です。
  **`nuka run` だけが報告できる失敗**: step や hook が `"pending"` / `"skipped"` を返す場合と、glue が done callback を使う場合です。
  これらの失敗は、step が実行中に行うことに依存します。
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
- [docs/migration.ja.md](migration.ja.md) は、既存の cucumber-js と Playwright のスイートに対する手順を示します。
  [docs/upgrading.ja.md](upgrading.ja.md) は、既存の nukadoko プロジェクトを新しいリリースへ移す方法を説明します。

## 第二の扉: Playwright Test のスイート

最初の扉は、cucumber-js の上に組み立てられたスイートで import を変更する方法です。
Playwright Test に対して直接書かれたスイートには、その import がありません。
テストは `test("...", async ({ page }) => {...})` を使い、リダイレクトする glue レイヤーもありません。
このスイートには、別の移行方法が必要です。

[docs/migration-playwright-test.ja.md](migration-playwright-test.ja.md) は、この扉の手順を示します。
`docs/migration.ja.md` は、最初の扉を扱います。
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
`page`、`context`、`request`、`baseURL` は、どちら側でも Playwright のオブジェクトです(「Context API」を参照)。
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

**record** は、移行のもう半分です。
実装を共有しても、record は作られません。
Playwright の run は Playwright の成果物を作りますが、step record を書く nukadoko executor がありません。
したがって、スイートがすべての実装コードを共有しても、`nuka harvest` の入力が作られないことがあります。

`recordStep` は、不足する record を作ります。
nukadoko は自分のテストでこの API をテストしましたが、実際に移行したスイートではまだ使われていません。

```ts
const opened = await recordStep(
  openCartStep, { sku }, { name: "open-cart", rootDir, request },
);
const added = await recordStep(
  addItemStep, {}, { name: "add-item", rootDir, request, use: [opened.stepRecordId] },
);
```

**record の id を渡します。**
spec は通常、返された値を変数に保存し、次の呼び出しへ渡します。
この操作は連鎖を記録しません。
`use` オプションは、`nuka do --use` と同じ意味で連鎖を宣言します。
`use` がなければ、record はそのキーを呼び出し元から渡された値として扱います。
その場合、`nuka harvest` はその run の id を下書きに書きます。
下書きは id を覚えているサーバでは通りますが、新しいサーバでは失敗します。
record の id を渡すと、`nuka run` と同様に `from` が値を提供できます。

step は spec の `request` を使い、schema を強制し、`nuka do` の record と同じ場所に step record を書きます。
既存のスイートが record の供給元になります。
`nuka harvest` は、既存の道のりを下書きに変換できます。
この方法では、チームは既存のコードを書き直さずに実行します。

`recordStep` は `request` に加えて `page` を受け取り、`page.context()` から context を取得します。
したがって、browser 中心のスイートと HTTP 中心のスイートをサポートします。
evidence の収集は、呼び出し元の context にリスナーを追加します。
実行が終わると、リスナーを削除します。
削除しない場合、1 つの記録済み step が spec の残りの通信も数え続けます。

external record は、`nuka run` の record より少ないデータを含みます。
trace chunk、スクリーンショット、page 通信の `http.jsonl` 行は含みません。
Playwright がすでにこれらの成果物を作るため、2 つ目のコピーは情報を増やしません。
external record は、nukadoko だけが計測する args、バリデーション済み result、`observed`、page event を保持します。

3 つの性質が、record の意味を維持します。
1 つ目は、record が `kind: "external"` を持つことです。
これは `do` と `run` に続く 3 つ目の実行元であり、人が入力したコマンドの record と区別します。
`harvest` は external record を受け入れますが、すでに feature を持つ `run` record は引き続き拒否します。
2 つ目は、nukadoko が注入された request context を通常のログと redact のためにラップすることです。
別の所有者が開いたため、その context を破棄しません。
破棄すると、あとで行う呼び出しが失敗します。
3 つ目は、呼び出しが `page` を渡さない場合、nukadoko が browser を必要とする step を record の作成前に拒否することです。
この経路は browser を起動しません。

**sign-off** には、別の経路が必要です。
`nuka accept` には、成功した `nuka run` のフル実行と scenario record が必要です。
external record は、この要件を満たしません。
nukadoko が保証できるのは、自分で駆動した実行だけです。
external record は、`do` record と同じ作業 record です。
harvest する scenario の材料であり、受け入れの evidence ではありません。

この移行によって、nukadoko の 2 つの経路が開きます。
`nuka run` は feature ファイルに経路を固定し、`nuka do` は各 step を単体で実行します。
既存のスイートがすでに信頼する操作は、agent が探索に使う語彙になります(「単体 step」と「Live sessions」を参照)。

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

## 実行

### Scenario(スクリプト化された経路)

```sh
nuka run features/checkout.feature[:12] [--env <name>] [--session <name>] [--quiet]
```

`@cucumber/gherkin` は、ファイルをフラットで自己完結した pickle にコンパイルします。
コンパイラは Background をマージし、Scenario Outline を展開して、table を結び付けます。
nukadoko は各 pickle の step をコミットされた pattern と照合してから、step を順番に実行します。
各 step に 1 つの step record を書き込み、各 pickle に 1 つの scenario record を書き込みます。
scenario record は feature のパス、scenario 名、順序付けられた step record id、step ごとの status を含みます。

`nuka run` は 1 つの feature ファイルの代わりにディレクトリも受け取ります。
`nuka run features/` はそれを再帰的に歩いてすべての `.feature` ファイルを見つけ、それらの pickle をすべて上記と同じ 1 つの invocation に畳み込みます: 1 つの run_id、1 つのサマリ、1 つの exit code、1 つの messages ストリーム、1 つの Allure results ツリーです。
ファイルはリポジトリ相対パスをロケールではなくバイトごとに比較した、決まった順序で処理されます。
そのため、どの scenario が何番目に実行されたかは run をまたいで安定し、ある record やレポートを別の run のものと比較できます。
ディレクトリに `:line` を付けると拒否されます。
`:line` は 1 つのファイルの中から 1 つの scenario を選ぶものであり、ディレクトリはその中から選ぶべき単一のファイルを名指ししていないからです。
配下のどこにも `.feature` ファイルを持たないディレクトリも拒否され、`nuka check` 自身の `no-step-files-found` と同じ語り口で、実際に何を歩いたかを名指しします。
何もしなかった run は、exit 0 で何もしなかったことにするのではなく、それを大声で言わなければならないからです。

各 run は、2 種類の読み手に 2 つの出力チャネルを使います。
stdout には、スクリプトが読む 1 行 1 件の scenario record を NDJSON として出力します。
run を見守る人向けの出力は stderr に置きます: 各 pickle の前の境界、各 step の後の 1 行、run が書いたパス、1 行のサマリです。
`--quiet` は step ごとと scenario ごとの進捗行を抑止します。
このフラグは端末を静かにしますが、無音にはしないため、パスとサマリは表示されます。

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
失敗した step は scenario の残りをスキップし、スキップされた step には step record が作られません(始まってすらいない実行が引用可能であってはならず、「skipped」と言うのは scenario record の役目です)。
Evidence は自然なスコープに従います。
各 step の record は、その step 自身の http.jsonl と、その step 自身の Playwright trace の両方を持ちます。
trace はかつて、共有された context 全体にまたがる 1 本のファイルとして scenario 自身のディレクトリに置かれ、`page` を bag に名指した最初の step で一度だけ開かれ、最後に一度だけ閉じられていました。
今は step の境界ごとに切られ、ブラウザに一度も触れない step にはそもそも trace の chunk が無く、触れた step にはその step 自身の操作だけが入った chunk があります(これは step 自身の fixture bag がすでに持っていた「必要な名前だけ構築する」という性質と同じ切り方です)。
落ちた step の trace を直接開けるほうが、何が起きたかを scenario 全体の録画からスクラブして探すより速く、それがこの変更の理由のすべてです。
シナリオ全体の 1 本の trace がついでに与えていたもの、つまり全 step をまたいだネットワークの通し view は、step ごとの trace には無くなります。
各 step 自身の trace にはその step 自身の通信は変わらず入っているので、1 つの step 単体の通信について失われるものは無く、失われるのは scenario 全体の通信を 1 つのファイルだけ開いて眺められるという点だけです。
`request` fixture の通信と page 自身の通信は、いまや同じ step ごとの view を共有します。
どちらも同じ http.jsonl に載り、各エントリには `via: "request"` か `via: "page"` の印が付くため、読み手はどちらの経路が通ったかを推測せずに済みます。
http.jsonl に載る page 由来のリクエストは `document`/XHR/`fetch` の 3 種類だけです(1 回のページ読み込みは画像やスタイルシート、スクリプトの束を何十件も引き込みうるため、それを全部保持しようとするファイルは読み手が開けるものではなくなってしまいます)。
ただし落とされたことが黙って消えるわけではありません。
落とされた分は step record 自身に、リソースタイプ別に `http_omitted` として載ります(「Records」を参照)。
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
nuka do archive-project --use step-20260801-143022-a1b2
```

1 つの型付き step を実行し、その step record を stdout に出力します(ok なら exit 0、failed なら 1)。
これが適応的なループです。
agent はバリデーション済みの result を読み、次の呼び出しを決めます。
agent が選べるのはどの step をどの args で呼ぶかだけで、何が記録されるかを選ぶことはできません。
`do` には意図的にグループ化のラベルがありません。
ad-hoc な一連の呼び出しは作業記録であり、evidence ではありません。
証明する価値のあるものはすべて scenario として表現され、`nuka run` によって証明されます(Self-healing を参照)。

`--use <step-record-id>`(繰り返し指定可)は、scenario なら chain が渡していたはずの値の代わりに、以前の実行から step の `from` キーを供給します(「step の連鎖」を参照)。
上流の step の名前がコマンドラインに書かれないのは、step record がすでにそれを運んでいるからです。
nukadoko はその record がどの step のものかを読み、そこを指す `from` のエントリを見つけ、名指しされたキーをその record に保存された `result` から取り出します。
この step が `from` を宣言していない step の record は、黙った no-op ではなくエラーになります。
実行が失敗した step record も同様にエラーになります。
失敗した step は読み取れるバリデーション済みの結果を一度も生み出していないからです。
同じキーについては scenario の中で pattern の capture が勝つのとまったく同じように、`--args` は今も `--use` に勝ちます。
実際に取り出された record id はこの実行自身の `used` に載るので、複数回の `do` 呼び出しにまたがって手で組み立てた chain も、scenario が駆動した chain と同じくらい後から追跡できます。

`--use` が運ぶのは値そのものであり、それが指すものがまだそこにあるという保証ではありません。
上流の step が返した path は、fixture が所有するリソースを指していることがあります。
`do` の下では 1 回の実行が fixture の scope のすべてなので(「Fixtures」を参照)、後から別の `--use` 呼び出しがその path を読み込む時点では、その fixture はすでに teardown 済みかもしれません。
返り値が fixture が teardown するものを指しているかどうかは、schema からも step 自身のコードからも読み取れません。
だからこれは、実行より前に `check` が捕まえられる間違いではありません。

`do` の下で通った step は、それだけでは `run` の下でも通ることが示されたわけではありません。
`do` はすべての実行にそれぞれ専用のブラウザとそれ以外のすべてを与えますが、scenario はそのすべての step に 1 つの context を与えるので、2 番目の step は 1 番目が残したものをそのまま引き継ぎます(すでにログイン済みかもしれず、別のページにいるかもしれず、ダイアログが開いたままかもしれません)。
この 2 つの問いは別物であり、どちらの答えも他方の代わりにはなりません: `do` はその step が動くかどうかを問い、`run` はそこで動くかどうかを問います。
`--session` は storageState を `do` の呼び出しをまたいで持ち運ぶことでこの差を狭めますが、それがカバーするのはログイン状態だけであり、それ以外の何ものでもありません: 実行がどこまで進んでいたかはそこには含まれません。
これがいちばん厳しく効くのは、自分自身の setup が 2 回目の実行では no-op になってしまう step で、直すべきは engine ではなく feature の側です: 状態は step ごとに毎回立てるのではなく、それを行うと名前が言っている step の中で一度だけ立てます。

### Live sessions(たどり着いた場所からの探索)

ここまではすべて、何もない状態から始まります。
`nuka do` は実行のたびに専用のブラウザとそれ以外のすべてを与え、それが 1 回の呼び出しを単独で読めるものにする一方、探索を高くつくものにもします: 20 番目に試したいことの前には、19 個のことが立ちはだかります。
読み取りだけならこれは遅いだけで済みます。
繰り返せない作業、たとえば一度しか開けないアカウントや二重に発行されてしまう請求書では、それすら不可能です。

**live session** は、あるプロセスが開いたまま保持し続ける 1 つの `ctx` です。
実行はそのたびに世界をゼロから組み立てる代わりに、次々とそこへ着地できます。

```sh
nuka session start alice
nuka do open-cart --session alice
nuka do add-item --session alice --args '{"sku":"S-1"}'
nuka session stop alice
```

持続するのはブラウザではなく context 全体です。
ブラウザだけを持続させると、世界が半分だけ古いという状態になります。
たとえば、この実行のために作り直された user fixture が、5 回分の実行を経たページのすぐ隣にあり、どちらがどちらなのかを示すものが何もありません。
fixture bag をまるごと開いたまま保持すれば、この問いそのものが消えます。
何であれ、その下で作り直されるものが一つもないからです。

これは新しい寿命ではありません。
scenario はすでに 1 つの `ctx` を組み立て、それに対していくつかの step を実行し、teardown します。
live session はそれと同じ寿命であり、違いは step の並びが feature ファイルからではなく 1 つずつ届く点だけです。
2 つの fixture のスコープに 3 つ目の値は要りません: `scenario` scope はその session の間続き、`process` scope はその session の process の間続きます(「Fixtures」を参照)。

**lock file が待ち合わせ場所であり、それはすでに存在します。**
session の `cache/sessions/<env>/<name>.lock` は `{ pid, started_at }` を保持し、今日すでに `process.kill(pid, 0)` と照合されています。
死んだ pid の lock はすでに古びたものと定義されており、誰でも取って代わってよいことになっています。
`nuka do --session alice` はそこで生きている pid を見つければその実行をそのプロセスへ渡し、見つからなければ今と完全に同じようにふるまいます。
新しく見つけ出すべきことは何もなく、死んだ所有者の主張には価値がないという規則も、すでに効いているものと同じです。

session を止めると、その storageState は session が昔から残してきたのと同じ `cache/sessions/<env>/<name>.json` に書かれます。
つまり session が持つのは 2 つの意味ではなく 2 つの寿命です。
生きている間は 1 つの process であり、生きなくなったあとはそれが保存した state です。

**live session から出た record は、まっさらな record と同じようには読めてはいけません。**
誰も組み立て直せない世界に対する 30 番目の実行として通った step は、その step が単独で通ったのとは別のことを証明しています。
この 2 種類を見分けられない green な record こそ、この機能が周囲のあらゆる record を静かに損ないかねない唯一の経路です。
`session` はすでに step record に載っています。
live session が付け加えるのは、それが live だったことと、この実行がその並びの中で何番目だったかです。

session ごとに、同時に実行できるのは 1 回だけです。
lock はすでに「今これを誰かが所有している」ことを意味するので、使用中の session に対する 2 回目の `do` はキューに積まれるのではなく拒否されます。
探索を駆動するのは、直前の結果から次の呼び出しを決める何かであり、2 人の呼び出し元が同時に決めることはそれではありません。

ここで起きることは何も evidence にはなりません。
そして、そうあり続けるための新しい柵は要りません。
live session は step record を生みますが、scenario record は生みません。
`nuka accept` は green なフル実行なしには拒否します(「Sign-off」を参照)。
だから探索から sign-off への道は、`nuka harvest` と本物の `nuka run` を通るか、そもそも存在しないかのどちらかです。

`nuka run` と `nuka accept` は live session を見つけると、その名前と止め方とともに報告しますが、それを理由に何かを拒否することはありません。
表に出す価値がある事実は、探索がそこに置いた state をアプリケーションがまだ保持しているかもしれないということであり、これはまさに、scenario が誰も書き残していない理由で通ってしまう類のことです。
その session が accept されようとしている feature と何か関係があるかどうかは、ここからは分かりません。
だからこれは事実として報告されるのであって、断定として報告されることは決してありません。

live session が listen する socket は、storageState ファイルと同じ生の認証情報を保持しており、同じ理由から同じ制限されたパーミッションで作成されます(「State directory」を参照)。
ただし、そのファイルの隣には置かれません。
unix socket のパスの長さには、どのプラットフォームにも上限があります。
プロジェクト自身のパスはいくらでも深くなりえます(worktree、monorepo の中のパッケージ、入れ子の checkout)。
プロジェクトの置き場所のせいで超えてしまう上限は、session の名前を短くしても戻ってきません。
そのため socket は、OS の一時ディレクトリの下に作られた専用のディレクトリの中に置かれます。
こうすると長さがプロジェクトの置き場所に依存しなくなり、実際のパスは session の lock ファイルが名指しします。
既定でアイドルタイムアウトが適用されます。
中断された探索が残す普通の結果は忘れられた session であり、珍しい結果ではないからです。
`nuka session list` は pid が消えている session を回収します。

正直な限界こそがこの機能の要点であり、欠陥ではありません。
30 回の実行を経た世界は、それを保持しているプロセス自身を含め、誰にも再現できません。
だからこそ、探索から出てくるのは run そのものではなく、収穫されてゼロからもう一度実行される下書きです。

## Records

step record は、1 回の step 実行に対するツールの計測を含みます。
step が scenario 内で実行された場合も、`do` で実行された場合も形は同じです。
scenario record(「実行」を参照)は、次の粒度で同じ問いに答えます。
1 つの pickle の run が、順序付けられた step 全体で何をしたかを示します。
2 つの record は、同じ概念を異なる粒度で示します。
scenario record の `steps` 配列は各 step record を id で示すため、どちらの record からでも他方にたどり着けます。

```json
{
  "step_record_id": "step-20260801-143022-a1b2",
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
  "scenario_record_id": null,
  "run_id": null,
  "started_at": "...",
  "finished_at": "...",
  "evidence": {
    "dir": ".nukadoko/records/steps/step-20260801-143022-a1b2",
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
- `args` も同じ分かれ方をします(この背後にある拒否については「型付き step」を参照)。
  `ok` な record では `run` が実際に受け取った、スキーマで検証済みの値です。
  呼び出し側が書かなかったキーにスキーマ自身の `.default(...)` が入った場合も含みます。
  `failed` な record では与えられたものをそのまま保持します。
  スキーマがすでに拒否した値を、検証済みの形に組み立て直すことはできないからです。
  compat の step の `args` は、検証対象のスキーマが無いため、どちらの結果でも検証されません。
- `scenario_record_id` と `run_id` は、この実行が何に属するかを名指しします。
  `run`-originated な step(`kind: "run"`)では所属する scenario record の id と `nuka run` 呼び出し自身の id、`do`-originated な step ではどちらも `null` です(`do` はどの scenario にも run にも属さないため)。
  `run_id` が無かったころは、ある step record がどの run のものかを知るのに隣の scenario record を開く必要がありましたが、いまは step record 自身が、この 1 回の実行が何をしたかについてすでにそうしているのと同じように、それに自分で答えます。
- `error.kind` は閉じた集合を使い、人が読むメッセージの隣に置かれます: `args_invalid`、`result_invalid`、`binding_invalid`、`world_invalid`、`timeout`、`unsupported`、`step_error`。
  閉じているのは、レポートがこれに対して分類を行うからです(step ごとに拡張される開いた集合では、何も分類できません)。
  最初の 4 つは、契約があるからこそ存在する失敗を指し、return 値を捨てる runner の上に作られたレポートでは埋められない部分です。
  確信が持てない分類器が `step_error` を返すのは、契約違反を誤って主張するほうが、主張しないより悪いからです。
  scenario record の中の hook record も同じフィールドを持ちます。
- `mutates` は step 自身の宣言を保持します(compat の step には記録すべき宣言がないため `null` になり、`false` にはなりません)。
  `observed` のカウントと並んで置かれるため、宣言された値と計測された値を別の artifact なしに比較できます。
- Evidence は harness によって収集され、step が自己申告することは決してありません。
  ブラウザが使われるときは Playwright の trace とスクリーンショット、`request` fixture の呼び出しと page 自身の document/XHR/fetch の通信はすべて http.jsonl に記録され、step record 自体が一次記録になります。
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
  step record の `name`/`file` という文字列は、他のどのフィールドとも同じ 1 回の redact を通ります。
  attachment 自身のファイルの *中身* は決して redact されません(任意のバイト列を redact すれば、保護するのと同じくらいの頻度で壊してしまうからです)。
  `attach` に渡すものを secret 抜きに保つのは、step 自身の責任です。
- `http_omitted` は、少なくとも 1 件の page 由来のリクエストが省かれたときだけ現れます。
  省かれたものを数えることで、その省略を可視化します。
  http.jsonl に入らなかった分をリソースタイプ別に数えます。
  例えば `{ "image": 34, "stylesheet": 5, "script": 12 }` です。
  `observed`(上記)はこれによって一切狭められません。
  image や script の通信も含め、harness が見たリクエストをすべて数え続けます。
  それは http.jsonl とは違う問い(実際に何回の読み取り・書き込みが起きたか)に答えているのに対し、http.jsonl が答えるのは(そのうちどれが 1 つずつ読む価値があるか)という別の問いだからです。
  2 つの数は互いに一致することを期待されておらず、どちらかがもう一方より小さくてもバグではありません。
- `used`(空でないときだけ現れます)は、この実行が値を引き出した以前の実行の一覧です。
  `from` による注入、`resultOf` の呼び出し、あるいは `nuka do` での `--use` の step record のいずれかを通じたものです。
  どの経路もライブラリのコードを通るため、読み取りは計測されるのであって宣言されるのではありません。
  各エントリは `{ "step_record_id": "step-…", "step": "create-project" }` の形です。
  step 名は引用元の step record と重複していますが、それでも書き留めます。
  読むために他のファイルと突き合わせなければならない record は、単独で読める record より読み手にとって劣ったものであり、突き合わせる相手になるファイルはローカルな作業記録にすぎず、sign-off(「Sign-off」を参照)よりずっと先に寿命が尽きるからです。
  エントリは record id で重複排除され、最初に読まれた順に並びます。
  依存関係はこうして二重に可視になります: 静的には `from` か import として、実行時には step record 連鎖の provenance としてです。
  値がどの上流の *step* から来たかは、その step ファイルが書かれた時点ですでに決まっていました。
  そのどの *実行* が値を供給したかは、ここでしか分かりません。
- **失敗した** step record だけが、各 `used` エントリに `result` を追加します。
  id/step のすぐ隣に置かれる、上流の step record のバリデーション済みの result 全体です。
  これにより、step が実際に何を見たかを確かめるためだけに 2 つ目の `record.json` を開かなくても、失敗した step record 単体を読むだけで済みます。
  `ok` な step の `used` エントリが `result` を持つことは決してありません。
  重要だった値はすでにその step 自身の `result`(`from` 経由で入ってきた場合は `args`)に載っているため、そこで上流の値を繰り返しても冗長になるだけだからです。
  運ぶのは result 全体であり、`from` の注入や `resultOf` の呼び出しがたまたま読んだ 1 つのキーに絞り込まれることはありません。
  失敗を診断するのに必要なのは、どのキーが参照されたかではなく、上流の値が *なぜ* そうなったかだからです。
  参照されたキーに絞り込んでしまうと、step record 側で同じ罠を作り直すことになります。
  それは「後続の step が参照するものを返す」という、参照だけに頼る罠であり、「型付き step」ですでに戒められているものです。
  これはまた、このフィールドが運べるのは上流の step 自身の `returns` スキーマがそもそも保持していたものだけだということも意味します。
  値を落とす `returns` は、ここからもその値を落とします。
- `calls`(空でないときだけ現れます)は、この実行が `call` fixture を通じて実行した part を、呼び出した順に列挙したものです(「Parts」を参照)。
  各エントリは `{ "step": "create-project", "args": {...}, "result": {...}, "started_at": "...", "finished_at": "..." }` の形です。
  part が失敗したときは `result` の代わりに `error` を運び、その分類は step record 自身の `error` と同じです。
  step record 自身のトップレベルの `args`(上記)とは違い、ここでの `args` はどちらの結果でも常に `call()` に渡された生の値です。
  part について変わったのは `call()` が何を受け入れるかであり、何を書き残すかではありません。
  part がさらに part を呼んでいれば、そのエントリの下に自分自身の `calls` を運びます。
  これらは step record ではなく、`step_record_id` を持ちません。
  `--use` が引用するのは step record であり、この実行が後続の実行に差し出すのはその実行自身の `result` だからです。
  各内部境界で args と result を記録することこそが、複合 step の record が失敗したあとに読まれる理由です。
  その境界を越えた値は、そうでなければどこにも残らないからです。
- `sections`(空でないときだけ現れます)は、この実行中に行われた `section` の呼び出しを、`{ "label": "...", "at": "..." }` の形でそれぞれ、呼ばれた順に並べたものです。
  `used` と違って重複は除きません。
  ループやリトライで 2 回入ったラベルは 2 回入ったのであり、配列はそのとおりに読めるべきです。
  一方 `used` が step record id を 1 回しか名指ししないのは、id が一連の中の一点ではなく、1 回引用する価値のある identity だからです。
  `at` は当初省かれていました。
  `sections` が答える問いは「どこで遅かったか」ではなく「どこで実行が止まったか」だという理屈からでしたが、それは半分しか正しくないとわかりました。
  ラベル 1 つだけでは、ある段階に到達したことしか言えず、この同じ record が運ぶ他の何に対して *いつ* だったかは言えません。
  実際の run がまさにその隙間を露呈させました。
  `status: "failed"` の隣に、対象がまだ存在していることを示す `final.png` が、およそ 8 秒違いで並んでいたにもかかわらず、record にはそれを言うものが何もありませんでした。
  額面どおりに読めば状態が点滅していたように見え、実際にそう誤診断されました。
  `at`(ISO 8601。`section` が呼ばれた時点でコレクタ自身が取得し、step が渡すことはありません)は、すべてのラベルを、`started_at`/`finished_at`、`polls` 自身の `at`、`evidence.screenshots[].at` がすでに共有している同じ絶対的なタイムラインに乗せます。
  これにより、「状態が実際に変化したのか」と「その読み取りは状態が落ち着く前に行われたのか」が、step record 単体からは見分けが付かない状態でなくなります。
  失敗した step の `sections` も、失敗するまでに到達したラベルをそのまま保持しており、その配列の最後の要素がすでに「どの段階にいたか」に答えているため、同じ事実の置き場所をもう 1 つ作る `error.section` フィールドは別途ありません。
  `section` を持つのは typed step の fixture bag だけで、compat step には `this` 上に対応するものがないため、`sections` は単に省略されます。
  これは、typed step が一度も chain から読み取らなかったときに `used` が省略されるのと同じです。
- `polls`(空でないときだけ現れます)は、この実行中に完了したすべての `poll` 呼び出しを記録します: `description` が渡されていればそれ、`at`(その呼び出しが始まった ISO 8601 の時刻)、predicate が実行された回数、経過したミリ秒、そしてどう終わったか(`resolved`、`timed_out`、あるいは predicate 自身が投げた場合の `failed`)です。
  呼び出し順ではなく完了順です。
  入れ子になった poll は、それを内包する poll より先に完了し、完了した poll だけが述べるべき件数を持つからです。
  timeout した poll も他と同じように記録されます。
  その timeout で失敗した step 自身の record こそが、まさにその数値が求められる場所だからです。
  `sections` と違って `polls` は、裸のラベルを超えたタイミングを常に運んでいました。
  それが存在する理由がタイミングの問いだからです: 0ms での 1 回の試行は、条件がすでに真だったこと、つまり待ちが no-op だったことを述べ、20 秒かけての 40 回の試行は、それが本当に遅かったことを述べます。
  この 2 つは step の外からは同じに見えながら、正反対の直し方を求めます。
  `at` は欠けていた半分、すなわち長さだけではない絶対的な開始点を加えるものであり、これにより poll は、測る基準点を持たない長さとして読まれる代わりに、`sections` と `evidence.screenshots` がいま共有しているのと同じタイムラインに置けるようになります。
  compat step にはそれを呼び出す fixture bag がなく、`polls` は単に省略されます。
  これは `sections` が省略されるのと同じです。
- `required_env`(空でないときだけ現れます)は、この実行中に `requireEnv` が呼ばれた名前を、初めて読まれた順に重複なく並べたものです。
  `used` や `sections` がすでに持っているのと同じ、宣言ではなく計測という形です。
  `requireEnv` はライブラリが制御できる唯一の呼び出し口だからです。
  キーが見つからず投げる前に記録されるため、`MissingEnvError` で失敗した実行の record にも、その step が何を要求したかが残ります。
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
  step は(`status: "ok"` のまま)裏で page がずっとエラーを投げていても pass することがあり、このフィールドが無かった頃は record にはそれを言うものが何もありませんでした。
  各種類は、少なくとも 1 件記録されたときだけ現れます。
  常に素の配列であり、件数によって種類自身の型が変わることはありません。
  `console_errors` は各エントリが `{ "text", "location": { "url", "lineNumber", "columnNumber" }, "at" }`、`page_errors` は各エントリが `{ "message", "at" }`(エラー自身の stack は決して含みません。
  trace.zip がすでに全体を運んでおり、stack を足しても redact が届くべき範囲を広げる割に得るものが少ないからです)、`failed_requests` は各エントリが `{ "method", "url", "failure", "at" }` です。
  `at`(ISO 8601)はコレクタ自身が取得します。
  `sections`/`polls` がすでに従っている、宣言ではなく計測という同じ規則です。
  種類ごとに 100 件で上限を設けます。
  リダイレクトループやうるさい page は 1 つの step で数千件を出しうるため、それをすべて保持しようとする step record は、読み手が開けるものではなくなってしまいます。
  上限に達した種類は素の配列のまま(引き続き 100 件が上限)であり、代わりに自分の名前を `page_events` の兄弟フィールド `truncated` に追加し、そこへ本当の総数を対応付けます。
  少なくとも 1 つの種類が実際に打ち切られたときだけ現れます。
  `"truncated": { "console_errors": 4213 }` という形です。
  以前のバージョンは同じ事実を、打ち切られた種類自身を `{ entries, total, truncated: true }` に変えることで報告していました。
  そのため件数によって種類自身の型が変わり、読み手はそこから件数を読む前にその型を判定して分岐する必要がありました。
  兄弟フィールドがある理由は、どの種類も常に同じ形のままにし、打ち切りは 1 か所で 1 回だけ報告される別の事実にするためです。
  他のどのフィールドとも同じように redact されます。
  secret はコンソールのテキストにも、失敗したリクエストの URL にも、他のどこにと同じくらい容易に載りうるため、このフィールド専用の別の redact 経路は存在しません。
  成功した step の record にも失敗した step の record にも、同じように現れます。
  page のエラーは page についての証跡であり、step についての判定ではないからです。
- `actions`(空でないときだけ現れます)は、この step 自身の trace chunk(上の `evidence.trace`)から読み出されます。
  この step が `page` fixture を通して行った Playwright の呼び出しすべてで、`expect` の待ちも含み、trace が完了を記録した順に並びます。
  ただし例外が 1 つあります。
  Playwright 自身が、すべての browser context について `console`/`weberror`/`requestfailed` イベントを内部で監視しており、その監視は step 自身のコードが行った呼び出しではないため、`actions` からは除外され、報告されません。
  `expect` も fixture ではありません(「Context API」を参照)。
  step は Playwright のテストファイルと同じやり方(`import { expect } from "playwright/test"`)でそこにたどり着き、trace はそのラッパーの下、Playwright 自身の層でその呼び出しを記録します。
  `goto`、`click`、その他すべての呼び出しがすでに同じ場所に載っているのと同じです。
  各エントリは `{ "method", "expression"?, "selector"?, "url"?, "is_not"?, "timeout_ms"?, "ms", "outcome", "at" }` です。
  `method` と 5 つの任意フィールドは trace 自身の呼び出しからそのまま写され、`ms` はその呼び出し自身の所要時間を trace 自身の時計で測ったもの、`outcome` は trace がその呼び出しに error を記録していれば `"failed"`、そうでなければ `"passed"` です。
  `at`(ISO 8601)は trace 自身の monotonic clock から絶対時刻に変換したもので、`actions` を `sections`/`polls`/`evidence.screenshots[].at` がすでに共有しているのと同じタイムラインに載せます。
  5 つの任意フィールドは allowlist であり、その呼び出しが運んでいたものすべてではありません。
  `setContent` 呼び出し自身の HTML 本文は一例ですが、数キロバイトに達することもあり、trace.zip にすでに全体があるのに step record にそれを必要とするものは何もないからです。
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
- Before、After、AfterStep hook は step record を持ちません(「Compat steps」を参照してください)。
  そのため、その呼び出し自身の trace 証跡は代わりに scenario record の `hooks` 配列にあるその呼び出し自身のエントリに載ります。
  `trace`(step record の dir ではなく scenario 自身の directory からの相対パスです。hook には record dir 自体がありません)、`actions`、`truncated` は、上と全く同じ形で、全く同じ規則のもとで現れます。
  hook の呼び出しには `sections`/`polls` は並びません。
  どちらも typed step の `section`/`poll` fixture から来るものであり、hook はどちらを呼ぶための fixture bag も持たず、持つのは World(`this`)だけだからです。
  hook 自身が明示的に呼んだものではなく trace chunk 自体から読み出される `actions` は、この gap の影響を受けません。
  ブラウザに一度も触れなかった hook の呼び出しは chunk を開かず、この 3 つのフィールドのどれも運びません。
  `page` を一度も分割代入しなかった step と同じです。
- `fixtures`(空でないときだけ存在します)は、その step 自身の bag 解決が実際に触れた `config.fixtures` エントリすべてを列挙します。
  `{ "name", "scope", "setup_ms"?, "at"?, "reused" }` です(完全な形と、`setup_ms`/`at` が新しく構築されたエントリにしか存在しない理由は「Fixtures」を参照)。
  teardown 自体はこのリストに含まれません。
  teardown はこの step record がすでに閉じたあとに走るので、`scenario` scope の fixture 自身の teardown 失敗は scenario record の `teardown_errors` に載ります(「Fixtures」を参照)。
- step record は `.nukadoko/records/steps/<id>/` の下に置かれます。
  scenario record は `.nukadoko/records/scenarios/<id>/` の下に置かれます(「成果物」を参照)。
  どちらもローカルな作業上の計測であり、そこから組み立てられる耐久性のある成果物が sign-off です。

## Session、environment、secret

nukadoko は、Cucumber が提供しなかった実行インフラを提供します:

- **Session** は Playwright の storageState として、CLI の呼び出しをまたいでログイン状態を運びます。
  nukadoko は各 session を environment ごとに保存し、advisory lock によって同時に 1 つの run だけに制限します。
  `--session` を指定しないことはクリーンな開始を意味し、暗黙に共有される状態はありません。
  session は daemon を使いません。
- **Environment** はデプロイ先に名前を付けます。
  各 environment は `baseURL`、`envFiles`、`policy: "read-only"`、任意の `version` プローブを定義できます。
  read-only policy は mutate する step を拒否します。
  各 step record はプローブの結果を `target_version` として保存します。
  sign-off は environment と version を凍結するので、記録は run が green だったデプロイ先を識別します。
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
  2 つ目の `{{redacted.NAME}}` マーカーはなく、step record を読む側は redact の形を 1 種類だけ覚えればよいということです。
  同じキーを `public` と `redact` の両方に名指しすることはできません。
  それは config エラーです。
  2 つのリストは、1 つのキーについて正反対の指示を与えるからです。
  secret の値は、出自にかかわらず、step record が出力されるあらゆる場所(`record.json`、`do` の stdout コピー、http.jsonl)で `{{secret.NAME}}` として redact されます。
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

Configuration は `nukadoko.config.ts` にあり、`defineConfig` を使います。
次の表は、受け付ける各キーを示します。
詳細があるキーは、後の段落か、その機能を説明する節を指します:

| キー | 内容 |
| --- | --- |
| `featuresDir` | feature ファイルと step のコード。`nuka run` が無人で実行する集合そのもの(デフォルトは `features`。Cucumber 流のやり方) |
| `additionalFeatureDirs` | `nuka check`/`nuka tend` が語彙を結び付ける対象を広げる追加のディレクトリ。`featuresDir` そのものを広げることはない(デフォルトは `[]`。下記) |
| `baseURL` | トップレベルの base URL。environment ごとに上書きされる(下記) |
| `envFiles` | トップレベルの env file。environment ごとに追記される(下記) |
| `environments` | environment ごとの `baseURL`、`envFiles`、`policy`、`version` プローブ(下記) |
| `stateDir` | nukadoko が実行時に書き込む場所(デフォルトは `.nukadoko`。「State directory」を参照) |
| `browserType` | `ctx.page()` が起動する Playwright のエンジン: `chromium`(デフォルト)、`firefox`、`webkit`(下記) |
| `browser` | Playwright 自身の `LaunchOptions`。そのエンジンの `launch` にそのまま渡される(下記) |
| `browserContext` | Playwright 自身の `BrowserContextOptions`。`browser.newContext()` に渡される(下記) |
| `requestContext` | `ctx.request()` に対応する `newContext` のオプション(下記) |
| `secrets` | `public`/`redact` のリスト。キーごとの redact の扱いを調整する(上記) |
| `parameterTypes` | カスタムの cucumber-expressions parameter type(下記) |
| `fixtures` | ユーザー定義の fixture(「Fixtures」を参照) |
| `fixtureTimeout` | fixture インスタンスごとの setup/teardown の既定タイムアウト(ms)(「Fixtures」を参照) |
| `allure` | `resultsDir` のみ(Allure emitter を参照) |
| `messages` | `output` のみ(Messages emitter を参照) |

`additionalFeatureDirs`(デフォルトは `[]`)は、`featuresDir` とは違う問いに答えます。
`featuresDir` は無人で *実行される* 集合です。
引数なしの `nuka run` はちょうどそのディレクトリだけを反復し、このキーがそれを広げることは決してありません。
`featuresDir` と `additionalFeatureDirs` を合わせたものが、静的チェックが語彙を *結び付ける* 対象となる集合です。
引数なしの `nuka check` と `nuka tend` はどちらもこの広い集合を歩きます。
ある step の pattern が結び付けられているかどうかはプロジェクト全体の性質であり、今日の無人の run が何を実行するかの性質ではないからです。
だからこそ acceptance feature(「Sign-off」を参照)は、`featuresDir` の外に留まる限り `additionalFeatureDirs` に属します。
`additionalFeatureDirs` にそのディレクトリを名指しすれば、その feature が結び付ける step は `pattern-unbound` として報告される代わりに結び付けられていると数えられ、それでいてなお無人では実行されません。
プロダクト自身の中核の経路を述べる feature は、accept された後 `featuresDir` へ移り、ここへのエントリは要りません。
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

`environments` と `fixtures` を両方名指しする例です:

```ts
export default defineConfig({
  baseURL: "https://acme.example",
  environments: {
    staging: { baseURL: "https://staging.acme.example", policy: "read-only" },
  },
  fixtures: {
    tenant: async ({ request }, use) => {
      const t = await createTenant(request);
      await use(t);
      await destroyTenant(request, t);
    },
  },
});
```

### State directory

nukadoko が実行時に書き込むものはすべて `.nukadoko/` の下に置かれ(`init` によって gitignore されます)、そのどれもコミットされることを意図していません。
目的別に 3 つのディレクトリへ分かれています(「成果物」を参照):

- `records/steps/<id>/`(step record ごとに 1 つのディレクトリ: record の JSON とその evidence ファイル(trace.zip、screenshots、http.jsonl))
- `records/scenarios/<id>/`(scenario の実行ごとに 1 つのディレクトリ: `record.json`、scenario 自身の最終スクリーンショット、そしてブラウザに触れた Before/After/AfterStep フックの呼び出しごとの trace chunk)。
  各呼び出しに一意な名前が付きます(例えば `hook-before-0.zip`、`hook-after_step-1-2.zip`)。
  複数の hook がこの 1 つのディレクトリを共有しうるからです。
  自分自身の `records/steps/<id>/` を決して共有しない step とは違います。
  これは Playwright 自身のテストごとの `test-results/` という規約を 1 階層上でなぞったものです。
  scenario 全体をまたぐ trace.zip はここにはありません。
  各 step 自身の trace は、その step 自身の `records/steps/<id>/` の下に置かれます(「実行」を参照)。
- `cache/sessions/<env>/<name>.json`(storageState。生の認証情報を平文で持ち、制限されたパーミッションで作成されます)
- `export/allure-results/`(emitter の出力。run をまたいで追記され、新しい Allure launch が欲しければ削除してよい)。
  `init` もこれを空のまま作ります。
  Allure 自身の CLI は、存在しないディレクトリでは起動を拒む一方、空のディレクトリなら受け付けるからです。
  これにより、最初の `nuka run` より前から `allure watch` を起動しておけます。
- `export/messages.ndjson`(messages emitter の出力)。
  このパスが持つのは常に、直近に *完了した* run 自身のストリームだけで、その run が終わった瞬間に原子的に置き換えられます。
  各呼び出し自身の、実行中の本当の書き込み先はその隣にある run-id 付きの兄弟ファイルです(`messages.<run_id>.ndjson`、その呼び出し自身の開始時に truncate される)。
  `nuka run` の呼び出し 1 回につき 1 つで、終わったあともディスクに残ります(Messages emitter を参照)。
  溜まったものを消すのは `nuka clean [--export]` です。

`nuka clean [--records] [--cache] [--export] [--dry-run] [--json]` は、この 3 つのディレクトリすべてにまたがって消すコマンドです。
カテゴリのフラグを 1 つも与えなければ、既定はその全部です。
カテゴリのフラグを 1 つ与えると、削除をそのカテゴリに限定します。
どこかで `nuka session` が 1 つでも live であれば、カテゴリを問わずコマンド全体を拒否します。
その session 自身のプロセスが、いままさに `records/` と `export/` に書き込んでいるからです(理由の全体は「成果物」を参照)。
カテゴリを問わず決して触れないファイルが 1 つあります。
`export/allure-history.jsonl` は `export/allure-results/` の隣にあり、その中にはなく、`.nukadoko/` の下にある成果物の中で唯一、再実行では作り直せないものです。

リポジトリには、feature ファイル、型付き step、sign-off record という耐久性のある成果物を置きます。

## Sign-off

sign-off は、合意された scenario が、名指しされた 1 つの commit で green だったことを記録します。
この主張はその commit だけに適用され、継続的なチェックにはなりません。
scenario はチケットの受け入れ基準から作ります。
green な run の後、プロジェクトは scenario を acceptance record として保持します。
nukadoko はそれを自動で再実行しません。

sign-off することと、feature を実行することは、別の問いに答えます。
sign-off は、その 1 つの commit で基準が満たされたことを記録します。
後の run は、CI であれ他の場所であれ、基準がいまも成り立つかを確認します。
sign-off の後、プロジェクトは scenario の今後の役割を選びます。
受け入れ基準の大半は、チケットが求めた変更について述べており、その変更が着地すれば、再実行が確認することはもう何も残っていません。
その場合 feature はそのままの場所に留まり、`additionalFeatureDirs`(「Session、environment、secret」を参照)に名指しされることで、無人で実行されることのないまま、静的チェックはその step を結び付け続けます。
一部の scenario はそうではなく、プロダクト自身の中の経路を述べており、チケットが閉じた後も長く真であり続けます。
そのような feature は `featuresDir` へ移り、`nuka run` が以後のすべての commit でそれを拾います(その sign-off がどう扱われるかは「Tending(手入れ)」を参照)。

```sh
nuka run acceptance/PROJ-123.feature     # execute, as often as needed
nuka accept acceptance/PROJ-123.feature  # freeze the last green run
```

- `accept` は feature を実行しません。
  sign-off は明示的な行為であり、green な run の副作用にはなりません。
  したがって、成功するまで accept を繰り返すことは意味のあるループではありません。
  コマンドは、その feature の直近の green な run を凍結します。
  feature のパスが run を識別します。
  run id は `nuka run` の出力を読む機械のためにあるため、ここで人が入力することはありません。
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
  acceptance record は、どの feature のものであっても、ここでの dirty には決して数えられません。
  それは accept 自身が生み出すものであり、凍結しようとしている run が読み込んだ入力では決してないため、それが untracked のまま、あるいは変更された状態で置かれていても、その run 自身の主張を偽にすることはないからです。
  判定は、`nuka tend` がすでに記録を普通のファイルと区別しているのと同じやり方によります(frontmatter が `run_id`/`commit`/`feature`/`scenarios` を運んでいること、「手入れ」を参照)。
  git がまだそれを追跡しているかどうかによってではありません。
  このチェックがそもそも読み込めないパス(おそらく計測された後に削除されたもの)は、引き続き dirty として数えられます。
  消された記録は本物の変更であり、この除外の対象ではないからです。
- red な run は acceptance record を生みません。
  verdict のフィールドも失敗の記録もありません。
  プロジェクトは通らなかった scenario を直して再実行します。
  プロジェクトは試行ではなく結果を残します。
- 記録は、それが由来する feature の隣に `<feature-basename>.<date>-<sha>.<environment>.<browser>.md` という名前で書かれ、accept した run 自身の条件が名前に織り込まれます(`<browser>` は、run がブラウザを一切起動しなかった場合は文字どおり `no-browser` になります)。
  こうすることで、同じ commit の同じ日であっても、2 つの条件が衝突して互いを黙って上書きすることがなくなります。
  browser の**バージョン**はファイル名には決して入りません。
  エンジンの種別だけで、その記録がどの条件のものかを識別するのに十分だからで、バージョンは記録の本文にだけ残ります(後述)。
  nukadoko はディレクトリを選びません: feature がどこに置かれるか、そして `featuresDir` へ移すかどうかは、プロジェクト自身の決定です(上記)。
  記録は常に feature の隣に書かれるので、feature を移せば記録もそれに追従します。
- accept が成功すると、`nuka accept` は記録自身のパスを stdout に書きます(以下のどれによってもこれは変わりません)。
  そして stderr には、プロジェクトが上ですでに答えたのと同じ問いを書きます: この feature が述べているのは変更なのか、それともプロダクト自身の経路なのか、そしてどちらの答えがどこに置くべきかを意味するのか、です。
  これは verdict ではなく案内です: このコマンドにはどちらであるかを計測する手段が無く、選択肢を名指しできるだけだからです。
- 記録本文自身は、冒頭近くに「Condition」節を運びます: `environment` と、accept した run がブラウザを起動していればその計測済みのエンジンとバージョンです。
  起動していなければ、空欄のままにするのではなく、その節がそのことを明示します。
  こうすることで「ブラウザを起動しなかった」ことと「読み手が確認し忘れた」ことが区別できるままになります。
  この節ができる前に accept された記録にはこの節がありません。
  `nuka tend` はそれを「条件不明」として扱い、条件を推測することは決してなく、この節による比較の対象にすることもありません(「手入れ」を参照)。
- acceptance record は、凍結する run からツールが組み立てます: feature の全文、scenario record、そして各 step 自身の step record です。
  step 自身の契約が名指したものだけに絞り込まれ、run の途中でブラウザがたまたま行ったことは含みません。
  人間が書き写すことは決してありません(書き写しは、計測を主張へと格下げしてしまいます)。
- ここで保持される step record は `step_record_id`、`step`、`kind`、`status`、`args`、`result`、`error`、`used`、`mutates`、`observed`、`calls`、`fixtures`、`required_env`、`world`、`started_at`、`finished_at`、`environment`、`session`、`session_execution`、`scenario_record_id`、`run_id`、`target_version` を運びます。
  `evidence`、`actions`、`truncated`、`page_events`、`http_omitted`、`declared`、`sections`、`polls` は外れます。
  `.nukadoko/` の下にある live な step record にはこれら全部がこれまでどおり残りますが(「Records」を参照)、そのどれも step 自身の契約が名指したものではありません。
  scenario record の中の hook のエントリ(「Records」を参照)は `type`、`status`、`error`、`step_index` を保持し、同じ理由で `declared`、`trace`、`actions`、`truncated` を外します。
- ここに埋め込まれる step record は、外すものの一覧によってではなく allowlist によって絞り込まれます。
  上に名指しされた field だけが残ります。
  live な step record に後から増える field は、上に名指しされるまで既定で外れます。
  記録は、外した key の名前を step ごとにではなく、その下に並ぶ step record と hook のエントリすべてについて、冒頭近くで一度だけまとめて記します。
  読み手が、何が外されたのかを推測する必要は決してありません。
- 外れる field は、ブラウザの trace が最も速く育つものです。
  実測では、ある 1 つの suite で、2 つの scenario、14 個の step が 3,844 行の記録を生み、そのうち `actions` だけで 2,288 行、全体の 60% を占めました。
  この大きさの記録は gitignore され、sign-off はリポジトリからもレビューからも外れます。
- 記録の中の各 scenario は、1 画面に収まる要約表も運びます: `step`、`status`、`ms`、`mutates`、`reads`、`writes` です。
  `ms` はその step 自身の `started_at` と `finished_at` の間の差です。
  `mutates` は step 自身の宣言であり、`reads` と `writes` はその `observed` の値です(下の「Declared vs observed」が比較するのと同じ組です)。
  JSON がこれだけ細くなった今、レビュアーが実際に読むのはこの要約表です。
- 記録の末尾にはもう 1 つのセクション、「Declared vs observed」があります。
  記録の中のすべての scenario にまたがるすべての step のうち、step record が `mutates: false` を宣言していながら、少なくとも 1 回の書き込みが計測された(`observed.http_writes > 0`、キーワードの意味論を参照)ものが対象です。
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

sign-off は過去形の主張だけをします。
この範囲は、requirements traceability matrix のような腐敗を防ぎます。
matrix は現在のシステムを記述すると主張するため、システムが変わるとずれます。
「commit X で green だった」は真であり続けます。
記録は、現在のソフトウェアの振る舞いについて何も主張しません。

記録は署名されていない平文の markdown です。
nukadoko は、記録が `nuka accept` の元の出力と今も一致するかを検証しません。
後の編集は git が検出します。
プロジェクトは記録を他のファイルと同じように commit するため、後の変更は記録を追加した commit との差分に現れます。

### 受け入れループ

agent は、チケットの受け入れ基準に対して次の手順を実行します。

1. 語彙を読みます(`nuka steps --json`、そして関連しそうなものの契約については `nuka describe <step>`)。
2. 操作が欠けているときは `nuka scaffold <name>` し、それを実装し、step record が正しく見えるまで `nuka do` で単体で動かします。
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

手順 1 から 4 に作業とレビューがあります。
新しい型付き step と feature は通常の PR の題材です。
レビュアーは、基準から scenario への翻訳を確認します。
手順 5 から 7 は機械的であり、ツールは無効な操作を明示的に拒否します。

このループは受け入れ基準から始まります。
「Harvesting(収穫)」は探索から始まり、このループの手順 3 で合流します。

## Harvesting(収穫)

`nuka do` は適応的なループを提供します(「単体 step」を参照)。
agent は 1 つのバリデーション済み result を読み、それを使って次の呼び出しを選びます。
その結果できる ad-hoc な一連の呼び出しは作業記録であり、evidence ではありません。
それが物語だと誰も合意していないからです。
したがって、探索で何か本物を見つけても、その発見は何もゲートできない形のままです。
探索の経路は、削除しても安全なディレクトリにだけ残ります。

`nuka harvest <step-record-id>...` は、それらの記録から 1 つの feature の下書きを組み立て、stdout に出力します。
このコマンドは、ツールが分けて保つ 2 つのものをつなぎます。
一方は適応によって見つかった経路で、もう一方は誰かが受け入れた文に固定された経路です。

```sh
nuka harvest step-20260817-a1b2 step-20260817-c3d4 > acceptance/cart.feature
```

このコマンドは、ツールの他の部分と同じ分業に従います。
`harvest` は、実行された step、その順序、各行のテキスト、行ではなく以前の実行が供給した値だけを埋めます。
step record は主張を含まないため、あらゆる**主張**を空欄のまま残します。

下書きには、同じ空欄が 2 つの形で現れます。
`Feature:` と `Scenario:` は、生成された名前ではなくプレースホルダーを使います。
各行は `Given`、`When`、`Then` ではなく `*` を使います。
キーワードは行の意味を読み手に伝えますが、記録が述べるのは何が実行されたかだけです。
キーワードを選ぶと、裏付けのない主張を作ることになります。
`*` は位置を持たない有効な Gherkin キーワードなので、物語ができる前でも下書きをパースでき、`nuka check` が読めます。

退けた代替案は、`mutates` からキーワードを導く方法でした。
もっともらしいキーワードはレビューを通る可能性がありますが、`*` は通らないため、ここでは誤った推測が推測なしより悪くなります。
下書きを仕上げる agent または人は、生成された推測も検証しなければなりません。

**コマンドラインは 1 つの一連に含める記録を選びますが、記録はそのグループを保存しません。**
グループ化のラベルがあると ad-hoc な一連の呼び出しが evidence に見えるため、`do` は意図的にそのラベルを持ちません。
各 `do` は step record を出力するので、適応的なループを動かす呼び出し元はすでにすべての id を持っています。
期間(`--since`、`--last 10`)を使うと推測になり、放棄した探りを含める可能性があります。
読み手は、その探りを本物の行と区別できません。

コマンドラインは*どの*記録を使うかを選びますが、順序は設定しません。
下書きは記録を `started_at` で並べるため、id を逆順に指定しても実行時の順序になります。
ここでは順序が計測であり、引数リストは選択だけを行います。

行に現れない値は連鎖に残ります。
step record の `used` は、各 `from` キーを供給した実行を特定します(「Records」を参照)。
この情報は再構築ではなく計測なので、`harvest` はそのキーを省き、生産者の行に供給させます。
その後、`nuka check` と `nuka run` が共有する束縛順序のチェックが、実行前に順序を証明します。
`--args` から来たキーについては、`harvest` が値を対応するキャプチャへ書き込みます。
入力が残り 1 つの required キーを消費できる場合は、docstring または table にも書き込めます(「型付き step」を参照)。
キーがどの場所にも当てはまらない場合、`harvest` はキーを省いてコメントを追加します。
その後、`check` は通常の理由でその行を拒否します。

`harvest` は、未解決の 3 つのケースを下書きと stderr の両方に記録します。

- **`pattern` を持たない step** は行になれません。
  `harvest` は、step とその args を示すコメントを追加します。
  scenario の目的によって、それが文のない step か、別の step の中にある part かが決まります。
  下書きは計測した事実を述べ、その判断を未決のまま残します。
- **実行が失敗した記録** は、失敗の内容を述べるコメント付きの行になります。
  これにより有用なケースが残ります。
  バグを再現した探索は red の scenario になり、振る舞いが変わると green になり、その後で受け入れられます。
  `nuka accept` は green なフル run を要求するため、red の下書きが誤って evidence になることはありません(「Sign-off」を参照)。
  `--use` がすでに拒否するため、失敗した記録は連鎖を供給できません。
  したがって、再構築は健全なままです。
- **元の記録へ読み戻らない行** は未解決のままです。
  pattern は optional text(`item(s)`)または alternation(`is/are`)を含むことがあり、どちらにも逆向きの形が 1 つだけあるわけではありません。
  そのため、`harvest` は生成した各行を `nuka run` と同じ matcher に通して読み戻します。
  そして、その行が同じ step と args に解決されることを検証します。
  一致しない場合、`harvest` は行、生成したテキスト、パース結果を報告します。

この往復だけが、`harvest` が出力を判定する場所です。
2 つ目の実装ではなく `run` の matcher を使うため、両方のコマンドが同じ行の意味を使います。

由来は stderr に出し、feature ファイルには入れません。
id は gitignore された state directory を指し、そのディレクトリは削除しても安全です(「The state directory」を参照)。
commit された feature がこれらの id を示すと、読み手がたどれない参照を含むことになります。
作業情報は作業と同じ場所に残し、耐久性のある feature ファイルには真であり続ける事実だけを残します。

`harvest` は `nuka run` の step record を拒否します。
その記録はすでに feature に属するため、2 つ目の feature を生成しても役に立ちません。
代わりに、拒否は元の scenario record を示します。

## Allure emitter

`nuka run` は scenario の pickle ごとに 1 つの Allure test result を書きます。
emitter は Allure 2 のファイル形式を使い、Allure 2 と Allure 3 の両方が読めます。
既定では、nukadoko は `.nukadoko/export/allure-results/` に result を書きます。
nukadoko は HTML をレンダリングしません。

`allure.resultsDir` は出力先を root からの別の相対パスへ移します。
emitter に有効化のフラグはなく、呼び出しが 1 件以上の pickle を選んだときに動きます。
呼び出しが 0 件の pickle を選んだときはスキップされます。
これは BeforeAll/AfterAll がスキップされるのと同じ理由で、その場合 `allure-results/` ディレクトリはまったく作られません。
`categories.json` と `environment.properties` は、run の最初、最初の step が始まる前に、一度だけ書き込まれます。
`nuka init` は既定のディレクトリを作るため、最初の run より前に `allure watch` を開始できます。

各 result は pickle の名前を使い、Gherkin の step を `steps[]` に格納します。
step 名は Gherkin keyword と AST の空白を保ち、`And` も正規化しません。
各 step entry は status、時間、parameter、attachment、宣言された log、call、計測された子 timeline を保持します。

result は次の label と path を持ちます。

- `feature` label は Feature 名を持ちます。
- `package` label はプロジェクト名と feature の path をドットで区切って持ちます。
- pickle が継承した各 tag は `@` を保つ `tag` label になります。
- scenario result は宣言されたすべての label と link を受け取ります。
- `titlePath` はプロジェクト名、feature のディレクトリ要素、Feature 名を持ちます。
- emitter は `parentSuite` と `suite` を未設定のままにします。
  この階層が必要な利用者は、宣言された label を使って suite label を追加できます。

`fullName` は `{project}:{feature path}#{scenario name}` です。
SDK は `fullName` から `testCaseId` を作ります。
`historyId` は `fullName`、`testCaseId`、そして scenario result が持つ `excluded` でないすべての parameter から作られる決定的なハッシュです。
scenario 自身の名前は独立した hidden parameter ではありません。
`fullName` を通じてすでに `historyId` に届いています。
すべての scenario result が identity のために持つ唯一の hidden parameter は `nukadoko.scenario.steps` で、その scenario 自身のすべての step のテキストを順番に連結したものです。
これは `excluded: true` ではなく `mode: "hidden"` です。
Allure はハッシュの計算前に `excluded` な parameter を落としてしまい、それでは意図そのものが無効になるからです。
`hidden` は parameter を UI から外すだけです。
Scenario Outline の行は、Examples の各セルを可視 parameter として追加し、これも `historyId` に加わります。
可視セルは以前の隠された行 parameter を置き換え、行を区別します。

2 つの scenario が Gherkin の名前を共有することがあります(たいていは 1 つの Scenario Outline の 2 つの行です)。
ハッシュへの入力がこれ以上なければ、両方が同じ `historyId` を使い、2 つ目が 1 つ目の scenario の history に入ります。
`nukadoko.scenario.steps` は通常の scenario についてこの隙間を塞ぎ、Outline の行自身が持つ Examples のセルは行についてこの隙間を塞ぎます。
どちらも救えないのは、名前と、すべての step 自身のテキストの両方を共有し、区別する Examples の行も無い 2 つの scenario です。
この組み合わせは、意図的に、区別が付かないままです。
誤った接続は接続が無いことより悪いため、この identity は見分けられる以上のことを決して推測しません。

この identity は、通常の scenario の history を構造変更の前後で維持します。
Scenario Outline の行は可視 parameter により identity が変わるため、変更後に 1 回だけ新しい history を始めます。
emitter は TestOps の移行用フィールド `_fallbackTestCaseId` を書きません。

step entry には run をまたいで残る identity がありません。
Allure の step-result モデルには、その identity を保存できる `labels`、`links`、`historyId` のフィールドがありません。
この設計より前に、それでも identity を計算する方法が 4 通り試されましたが、どれも別々の 2 つの step を同じものであるかのように誤接続しました。
step のテキストはそれ自身と衝突します(2 つの step がまったく同じ文言を持つことがあります)。
位置(index、行番号)は、feature ファイルのそれより前のどこかが編集されるたびにずれます。
出現回数を数える方法は、挿入された重複を元のものと区別できません。
行番号ベースの方式は、この失敗のしかたを具体的に見せてくれました。
feature ファイルの冒頭にコメント行を 1 行足しただけで、すべての step が隣の step の history を静かに乗っ取り、それが起きたという手がかりは出力のどこにもありませんでした。
誤った接続は接続が無いことより悪く、試したすべての方式が誤った接続を生んだため、step entry には identity をまったく与えません。
1 つの scenario result の中にネストされた 1 エントリとしてのみ読まれます。

`historyPath` の設定により、scenario の history が見えるようになります。
この設定は nukadoko ではなく Allure 3 を設定する `allurerc.mjs` に書きます。
この設定がないと、scenario の `historyId` が安定していても、Allure 3 は `generate`、`watch`、`report` の history を組み立てません。
identity が完全に安定していて `historyPath` の無いプロジェクトは、trend も、regressed/fixed の遷移も、flaky の検出も一切見えず、レポート自身のどこにも、config のキーが欠けていることを指すものがありません。
`nuka init` は生成する `allurerc.mjs` にこれを無条件で書き込み、`.nukadoko/export/allure-history.jsonl` を指します。
使い捨ての `allure-results/` ディレクトリの中ではなく、その隣に置かれるため、run のたびに result をクリアしても消えません。
[`examples/allure/allurerc.mjs`](https://github.com/meganemura/nukadoko/blob/main/examples/allure/allurerc.mjs) は、`nuka init` を使わないプロジェクト向けに同じフィールドを持ちます。
`historyPath` を設定しても、step entry 自身の history が見えるようになるわけではありません。
step entry はそもそも、それを組み立てるための identity を持たないからです。

既存のスイートを nukadoko に移行するチームは、Allure history、trend、retry tracking を新しく始めます。
以前のツールは別の `historyId` の計算方法で history を作っており、nukadoko は意図的にそれを再利用しません。
compat door は nukadoko に移るためのものであり、留まるためのものではありません。
nukadoko に移った後は、scenario の history が nukadoko 自身の run から新しく積み上がっていきます。

step entry は trace、HTTP log、検証済み result、`record.json`、宣言された attachment を含みます。
Data table は `Data table` という名前の CSV attachment になります。
Doc string は text attachment になり、allure-cucumberjs が省く内容も保持します。
Examples table は `Examples` という名前の scenario attachment になります。
`final.png` などの scenario evidence は scenario result に直接付きます。

step record を持つ各 step entry は、合否を問わず、完全な record を `record.json` として含みます。
これはディスクに書き込まれたのと同じオブジェクトです。
そこですでに redact 済みなので、ここで 2 度目の redact は行いません。
フィールドごとに分解せず丸ごと添付しているのは意図的なものです。
`record.json` に後からフィールドが増えても、emitter を変更しなくてもレポートに自動で届きます。
この節の他の場所で個別にマップされたフィールドもそのまま残ります。
1 つの事実を知りたいだけの読み手が attachment を開かなくて済むようにするためです。
`record.json` は、個別のマッピングが書かれていない場合でもレポートを完全に保つ、その受け皿です。

宣言された attachment には `declared:` を接頭辞に付けた名前が付きます。
すべてが同じ result ファイルに収まったとき、この接頭辞こそが provenance(nukadoko によって計測されたのか、step によって自己申告されたのか)の生き残る唯一の場所です。

宣言された log、計測された timeline entry、part の call は Gherkin step の下に子 step として現れます。

step entry は `sections`、`polls`、`actions` を 1 本のネストされた child step タイムラインにまとめます(「Records」を参照)。
emitter はそれらを `at` の昇順でマージします。
同じミリ秒に複数の entry が重なったときは、`sections`、`polls`、`actions` の順という決まった並びを保ちます。
同じ step record を読み直すたびに順序が入れ替わって diff が読めなくなる、ということがないようにするためです。
section は、自分のラベルを名前に持つ幅ゼロのマーカーとしてレンダリングされます。
poll は自分の開始点から `waited_ms` 後まで幅を持ち、名前は `<description> (<attempts> attempts)` です。
所要時間だけでは、1 回の試行で解決した待ちと 40 回かかった待ちを見分けられず、その回数こそが名前でしか運べない唯一の事実だからです。
poll 自身の outcome は child step の status を決めます。
`resolved` は passed、`timed_out` は failed(待っていた条件が満たされなかった、つまり step 自身の契約が成立しなかった)、`failed` は broken(poll のコールバック自身が例外を投げた、それは何を待っていたかとは無関係)です。
action は自分の開始点から `ms` 後まで幅を持ち、名前は自分の `method` に、呼び出しが持っていれば `selector` か `url` を添えたものです(例: `goto /orders`)。
`expect` の呼び出しだけは代わりに matcher と対象で名付けられます(例: `expect #late to.be.visible`)。
否定された assertion では `not` が畳み込まれます。
`goto` の対象が `url` から自明であるのと違い、`expect` の matcher と対象はどちらも `method` だけからは分かりません。
`ms` も `timeout_ms` も名前には決して入りません。
`ms` は child step 自身の幅としてすでに見えており、これは `page_events` の `observed` count を step の名前に入れない理由と同じです。
`timeout_ms` は `record.json` という attachment の中にとどまります。
`actions` 自身が 100 件で打ち切られていたとき(「Records」の `truncated.actions` を参照)、タイムラインの末尾にもう 1 つ、幅ゼロで passed の child step が加わり、打ち切りの事実を名指しします(例: `... 4113 more actions not shown`)。
タイムラインだけを見た読み手が、打ち切られたリストを全部だと取り違えることが決してないようにするためです。
親 step entry 自身の start/stop の範囲にクランプすることは決してありません。
その範囲の外に出た timeline entry は実際に起きたことであり、隠せば読めなくなるだけで、起きなかったことにはなりません。

emitter は `page_events` を最大 3 つの parameter として示します(「Records」を参照)。
parameter は `console errors (observed)`、`page errors (observed)`、`failed requests (observed)` です。
emitter は 1 件以上の entry を持つ種類だけに parameter を追加するため、読み手は `record.json` を開かずに件数を確認できます。
収集側が打ち切った種類は、表示件数の隣に真の総数を示します(例えば `100 of 4213`)。
表示件数だけでは、実際に起きたことを過少に見せてしまいます。

step entry の parameter は、その宣言と実際に `observed` されたものを並べて運びます。
計測された `http reads (observed)` / `http writes (observed)`(compat の step では `world reads (observed)` / `world writes (observed)` も)の隣に `mutates (declared)` が置かれます。
これは自動で照合されるからではなく、レビュアーが自分の目で見比べられるようにするためです。
宣言は nukadoko が信頼し作用する対象であり、`observed` の回数は実際に起きたことであり、この行は両者を目で見比べられる場所です。
`observed` は意味論上の判定ではなく HTTP メソッドによるプロキシです(「Keyword semantics」を参照)。
step が POST ベースの読み取りを呼んでいた場合、正直な `mutates (declared): false` の隣にゼロでない `http writes (observed)` が並ぶことがありますが、それはこのプロキシがテーブルに透けて見えているだけであり、どちらの数値も嘘をついているわけではありません。

失敗した scenario は `statusDetails.message` に `[nukadoko.failure=<kind>]` を入れます。
元の error message は `statusDetails.trace` に書きます。
marker は、失敗した step の step record(hook が scenario を止めた場合は、その hook 自身の record)がすでに持つ同じ `error.kind` を名指しし、同じ `error.kind` は `nukadoko.failure` という result label としても書き出されます。
2 つの Allure 世代は、それを別々の経路で category に変換し、利用者に求めるものも異なります。

- **Allure 2** には result ごとの category フィールドが無いため、emitter は run ごとに `categories.json` も書きます。
  このファイルは `error.kind` ごとに 1 つ、合計 7 つの rule を持ち、メッセージの接頭辞を正規表現で照合します。
  メッセージの接頭辞と category rule は同じ分類を表すため、利用者は追加の設定を必要としません。
- **Allure 3** は `allure generate` または `allure report` の実行時に、results directory の `categories.json` を読みません。
  Allure 3 は category を config だけから取得し、result の label と照合します。
  `nukadoko.failure` がその label を供給します。
  `nuka init` はプロジェクトの root に `allurerc.mjs` を書き出し、`error.kind` ごとに 1 つ、7 個の label-matcher rule を持たせます。
  この 7 個の名前は `NAME_BY_KIND`(`src/report/allure/categories.ts`)から組み立てられるため、emitter 自身が使う名前と決してずれません。
  プロジェクトの root に置けば自動で検出されます(Allure 3 はカレントディレクトリから `allurerc.{js,mjs,cjs,json,yaml,yml}` を自動検出するため、`--config` フラグは不要です)。
  `nuka init` はこの 6 つの拡張子すべてを先にチェックし、プロジェクトに既にどれか 1 つあれば何も書かず、見つけたファイル名を stderr に出します。
  そのどれも置かないと、すべての nukadoko の失敗は Allure 3 に組み込まれた 1 つの category「Product errors」に落ちてしまいます。
  `nuka init` を使わないプロジェクトは、[`examples/allure/allurerc.mjs`](https://github.com/meganemura/nukadoko/blob/main/examples/allure/allurerc.mjs) を手でコピーして置くこともできます。

Before hook と After hook は scenario scope の 1 つの Allure container を共有します。
各 hook は trace、attachment、子 timeline を持つ fixture になります。
hook 自身の trace と `actions` は、その hook 自身の fixture に付きます。
step entry と同じやり方でマップされ、trace は `trace` という名前の attachment として、`actions` は同じマージによって fixture 自身の child step タイムラインに合流します。
hook には合流させる `sections`/`polls` がありません。
`section`/`poll` を呼ぶための fixture bag を持たないからです。
それでも trace から読み出された `actions` は変わらずレンダリングされます。
`this.openPage()` に一度も触れなかった hook の呼び出しは、trace の attachment もタイムラインの entry もどちらも持ちません。
`page` に一度も触れなかった step entry が「何も表示するものがない」のと同じです。
Before hook の失敗は scenario result を failed にし、予定された各 Gherkin step を skipped にします。
BeforeAll と AfterAll には emitter が対応できる run level の record がありません。
scenario record は hook ごとの timestamp を持たないため、hook の duration は scenario の境界を使います。

`allure-results/` は `nuka run` がまだ実行中でも安全に読めます。
すべてのファイルは temp file の rename を通じて着地するため、読み手が書きかけの result を目にすることは決してありません。
scenario 自身の 1 つの本当の result は、その scenario が終わって初めて存在します。
それまでの間にライブの読み手が目にして更新されているのは、下の progress snapshot です。

emitter は scenario の開始時に最初の progress snapshot を書きます。
最初の snapshot は予定された全 step を status なしで列挙するため、Allure は各 step を unknown と表示します。
emitter は各 step の完了後に新しい `<uuid>-<連番>-progress-result.json` を書きます。
各 snapshot は、その時点で完了した step の status と時間を使います。

長時間動く step では、emitter はこの 2 点の間にも 10 秒ごとに snapshot を書きます。
その snapshot では、実行中の step を status 無しで描き、`stop` に書いた時点の時刻を入れ、いまの活動を子ステップとして 1 段の平坦に並べます。
子の出所は 2 つで、どちらも人が書いた言葉を運びます。
まだ再試行中の `ctx.poll` が `waiting for: <description> (attempt N)` を、到達済みの `ctx.section` のラベルが `section: <label>` を出します。
子の文字列は組み立てた場所で redact します。
snapshot の他の値は書き込み時に redact 済みの step record から来ますが、子にはその一度目がありません。

実行中の step にどちらの活動もない場合、emitter は heartbeat snapshot を書きません。
経過時間しか言えない tick は、読み手が既に見ているものを伝えるために、ページ全体の再読み込みを 1 回払うことになります。
知っておくべき帰結が 1 つあります。
poll も section も持たないまま 1 分走る step は、まだ始まっていない step と見分けが付きません。

間隔は 10 秒で、設定項目にしていません。
これは人がライブ表示を「止まっている」と読むまでの時間で、プロジェクトごとに変わるものではないためです。
1 つの step は 120 tick で打ち止めになります。
tick ごとに下記の `start` の予算を 1 つ消費すること、そして step のリトライ一覧が書いた snapshot の本数だけ行を増やすことが、上限を置く理由です。

1 つの scenario の全 snapshot は scenario の開始時に生成した uuid を共有しますが、それぞれ新しいファイル名を使います。
この両方が要ります。
詳細ページの route は result 自身の uuid のハッシュなので、uuid が動くと、すでに開いているページの足元から route が動きます。
そして `allure watch` が見つけるのは新しいファイルのパスだけで、読み終えたパスへの上書きは無視します。
Allure は result の uuid をファイル名ではなく JSON の中身から読むので、一方を固定したまま他方を変えられます。

snapshot は最終 result と同じ `historyId` を持ちますが、attachment、hook fixture、除外された文脈 parameter を含みません。
各 snapshot は固有の `start` を持ち、1 つ前の snapshot より 1 ミリ秒だけ大きくなります。
最初の 1 本は scenario 開始の `stepCount * 121 + 2` ミリ秒前に置かれるので、最後の 1 本も scenario 開始より前に留まります。
この予算は、step ごとの 1 本と、各 step が足しうる 120 回のハートビートを合わせたものです。
1 step 1 本で見積もった式は、step が tick するほど長く走った時点で足りなくなります。
最終 result は scenario の開始時刻を保つため、Allure は最終 result を canonical なリトライとして選びます。

Allure 3 は `retryHash` が同じファイルをリトライとしてまとめます。
これは `testCaseId`、除外されていない parameter、環境 id から作るハッシュです。
`historyId` は history と known-issue の突き合わせのために各 snapshot に載りますが、このまとめ方には関与しません。
Allure は `start` が最大の result を canonical として選び、`start` が同値のときは ingest 順に落とします。
snapshot ごとに異なる値を与えることが、この ingest 順の判定を使わせないための仕組みです。
ingest 順は `allure watch` では書き込み順と一致しますが、`allure generate` では一致しません。
後者はディレクトリをファイル名順に並べ、並行して読むためです。
この挙動は、このプロジェクトが pin している Allure 3.14.3 で実測し、`@allurereport/core` のソースでも確認しました。
Allure の README はこの挙動を文書化していません。

uuid の固定と `start` の増加は、対で初めて成立します。
1 つの scenario の全 snapshot は同じ store id になるので、Allure はその id の ingest 位置を 1 度だけ記録し、以降の書き込みでも同じ値を読み返します。
`start` が同値の snapshot が 2 つあると ingest 位置も同値になり、比較が 0 を返し、安定ソートが最初の snapshot を canonical の座に残したままにします。
その後に書かれたものは、run が実際に到達していた step も含めて、すべてリトライ扱いになり scenario の一覧から落ちます。
`start` の式を変えて 2 つの snapshot が同値になると、uuid の仕組みに触れていなくてもこれが戻ります。

Allure 3.14.3 で実測した限界が 2 つ残ります。
watch 中に開いた詳細ページは、その scenario を run の終わりまで追いかけ、そこで止まります。
最終 result は自分の route に置かれ、再読み込みは URL のフラグメントを保つので、そこへ届くには一覧から辿り直すしかありません。
同じページは終端の 1 つ手前で頭打ちにもなります。
N step の scenario は N+1 本の snapshot を書き、その最後の 1 本は最終 step と下記の掃除の間、watcher がポーリングを待つ 300 ミリ秒の中に置かれるためです。

Allure は result を読むたびに、その id が既に在るかを確認せずリトライの一覧へ追加するので、scenario のリトライ一覧には書いた snapshot の本数だけ行が並びます。
行数は、snapshot ごとに uuid を変えていたときと同じです。
変わったのは、どの行も同じ 1 ページを開くようになったことで、以前は行ごとに別の凍結 snapshot でした。
これらの行はライブの watch セッションにだけ現れます。
終わった results ディレクトリから生成したレポートには 1 行も出ません。

ライブ視聴中は、進行中の scenario のリトライに以前の unknown snapshot が見えることがあります。
scenario の終了時に、nukadoko は最終 result を書き、その scenario の progress file を削除します。
run の開始時には、中断した以前の run が残した progress file を削除します。
この掃除は、1 つの results directory で同時に動く run が 1 つであることを前提にします。

完了した result file は追記のみです。
emitter は既存の `allure-results/` ディレクトリをクリアも置換もしません。
progress file は nukadoko の作業ファイルであり、唯一の例外です。
2 回の `nuka run` の呼び出しを 1 つの Allure launch とみなすか 2 つとみなすかは呼び出し側に委ねられています。
新しい launch が欲しい利用者は、自分でそのディレクトリを削除します。
完了後の results directory は最終 result、container、attachment、launch metadata を持ちます。

将来の Allure がリトライをまとめる挙動を変えた場合、ライブ表示は step 単位の忠実さを失う可能性があります。
完了後のディレクトリには最終 result だけが残るため、生成したレポートは正しさを保ちます。

ad-hoc な `nuka do` の record はダッシュボードの対象外です。
探索した内容は feature に記録し、`nuka run` がその scenario を実行した時点でレポートの対象になります。

各 run は Allure が表示し、nukadoko 自身には web UI がありません。
history、trend、flakiness も Allure の機能です。
上の identity の段落のとおり、この emitter はそれらを `historyPath` が設定されていれば scenario 粒度で供給し、step 粒度では決して供給しません。
後の呼び出しの step entry が今回の呼び出しに紐づくことは何もなく、紐づくのは scenario だけです。

未実装なのは、`@issue:123` などの tag に対する link-template の設定です。

要点はフォーマットの派閥争いではありません。
従来の cucumber の実行が Allure レポートを満たすのは、glue の作者が手で evidence を添付した箇所だけですが、nukadoko の harness はどのみちすべてを計測しており、Allure 自身のモデル(attachment、label、parameter)には、その全部の一級の置き場所が既にありました。
Allure emitter は、nukadoko の計測の余剰が自動で、しかも今日既に見えるようになる場所です。
下にある messages emitter は 2 つ目の、より狭い出力であり、その役割は計測の余剰ではなく compat の忠実さです。
## Messages emitter

`nuka run` は呼び出しごとに、`@cucumber/messages` を通して 1 つの cucumber messages ストリームを書きます。
ストリームは 1 行 1 envelope の NDJSON を使い、既定の出力先は `.nukadoko/export/messages.ndjson` です。
`nukadoko.config.ts` の `messages.output` で、root からの別の相対パスを設定できます。
Allure と同様に、この emitter には `enabled` フラグも CLI フラグもありません。
呼び出しが 0 件の pickle を選んだ場合を除き、emitter は実行されます。

- 1 回の run は 1 つのファイルに 1 つのストリームを生成し、同時並行の呼び出しは別々のファイルを使います。
  各呼び出し自身の本当のファイルは、設定されたパス自身の名前に run id を差し込んだもので(既定のパスなら `messages.<run_id>.ndjson`、`messages.output: "out/stream.ndjson"` なら代わりに `out/stream.<run_id>.ndjson`)、設定されたパスの隣に置かれます。
  `begin` が truncate するのはこのファイルであり、設定されたパス自身ではありません。
  追記だと、読み戻せる単一の well-formed なストリームであるべきところに `testRunStarted` の envelope が 2 つ残ってしまうからです。
  これは、2 つの同時並行な呼び出しが 1 つの共有ファイルを互いに truncate してはいけない理由と同じです。
  以前はそうしていました。
  あとから始まったほうが、最初のストリームの開始を消す一方で、どちらも自分自身の終了は追記し続けたため、1 回の run では決して生まれない組み合わせがそこに現れていました。
  `end` はそのあと、この呼び出し自身のいま完全になったファイルの完全な原子的コピーで、設定されたパスを置き換えます。
  これがその最後の動作です。
  だから設定されたパスの読み手は、書きかけの run を決して目にしません。
  常にどちらか、直前の run の完全なストリームか、この run のものかであり、2 つが混ざることはありません。
- 設定されたパスは、run が進行している間は変わりません。
  `end` が完成したコピーを置くときに 1 回だけ変わります。
  run の途中でクラッシュしても、設定されたパスに残るのは直前の run 自身の完全なファイルであり、truncate されたファイルではありません。
  run をライブで見るのは Allure の仕事(`npx allure watch`)であり、このストリームの仕事ではありません。
- 各呼び出しのファイルは、設定されたパスの隣に残ります。
  「成果物」が示す理由により、これらのファイルを自動で消すものはありません。
  溜まったものを、設定されたパス自身のコピーとあわせて消すのは `nuka clean [--export]` です。
- この emitter は Allure emitter と逆の役割を持ちます。
  Allure は nukadoko の計測の余剰を公開し、この emitter は compat の忠実さを保ちます。
  唯一の仕事は、移行したスイートの既存フォーマッタと JUnit ベースの CI が、nukadoko の run を従来の cucumber-js の run と同じように読み続けられるようにすることです。
- step record の内部情報はストリームに入りません。
  対象はバリデーション済みの result、`mutates`、`observed` の件数、`error.kind`、`calls` です。
  `TestStepResult` と `TestStepFinished` は closed schema(`additionalProperties: false`)であり、そのどれにもフィールドがなく、Allure 自身の `[nukadoko.failure=<kind>]` label のような marker を通じてこっそり忍び込ませることもできません。
  `calls` には、それに加えてもう 1 つの理由があります。
  この形式には step の中の step という概念がそもそもありません。
  そのためスキーマが開いていたとしても、part がここで取る形はありません(「Parts」を参照)。
  Allure がそれを入れ子にできるのは、Allure 自身のモデルがそうしているからです。
- Attachment は step が自分自身について宣言したものだけを含みます: `declared` の attachment とログの行です。
  ログの行は cucumber-js の `text/x.cucumber.log+plain` という media type(`this.log()` が生成するもの)を使います。
  trace、スクリーンショット、HTTP log、バリデーション済みの result は Allure だけに留まります。
  その計測の余剰にはすでに置き場所があり、ここで trace を base64 で埋め込んでも、それを望む消費者がいないままストリームを太らせるだけだからです。
- `testRunFinished.success` は常に run の exit code と一致します。
  BeforeAll/AfterAll はこのストリームに書き込む場所を持ちません(emitter が汲み取れる run スコープの record が存在しないからです)。
  そのため run スコープのフックが失敗した run は、どの scenario の中にも現れず、ここにしか現れません。
- 内部の一貫性に加えて、実際の消費者がストリームの動作を確認しています。
  nukadoko の `messages.ndjson` を `@cucumber/junit-xml-formatter@0.14.0`(envelope ストリームの上で `@cucumber/query` を駆動するもの)に通してもエラーは投げられず、解決が必要なすべての id(pickle から testCase、testStepFinished へ、そして `pickleStepId` から gherkin の step へ)は解決できます。
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
プロトコルが `Exception.type` を要求する一方、step record が運ぶのは常にメッセージだけだからです。
これが、失敗した step の JUnit `<failure>` が body だけになる理由です。

## Self-healing(監査付き)

アプリケーションの変更によって、スクリプト化された scenario が現実にマッチしなくなった場合は、次の修復ループを使います:

1. agent は `nuka do` を使い、目標を 1 step ずつ適応的に実行します。
   agent は各 step record を読んでから、次の呼び出しを選びます。
2. step record は、スクリプト化された scenario との差分を含め、実際に動いた一連の呼び出しを記録します。
   それらは修復を説明しますが、証明にはなりません。
   agent はこの一連の呼び出しを PR で引用できます。
3. PR は型付き step、feature ファイル、またはその両方を更新します。
   修復された scenario の green な run が、scenario record と step record を通して証明を供給します。
   レビュアーは、それらの記録を他の変更と同じように調べます。
   証明は常に scenario を通り、ad-hoc な一連の呼び出しは通りません。

nukadoko はすべての段階を記録します。
同梱の agent skill が執筆のワークフローを提供し、エンジンが scenario を自動で修復するわけではありません。
監査証跡がないと、self-healing によってテストスイートの検査対象が気づかないうちに消える可能性があります。
逸脱の記録は、その消失が隠れたままになることを防ぎます。

## Tending(手入れ)

`nuka check` が答える問いは一つだけです。
今すぐこのプロジェクトを run できるか、です。
プロジェクトはあらゆる check を通過していても、それでも腐ることがあります。
sign-off は、自分が凍結したコードを言い表さなくなることがあります。
宣言は、何年も行使されないまま残ることがあります。
契約は、それを選ばなければならない agent にとって読めなくなることがあります。
これらの問題は run を止めません。
しかし、どれも時間とともに高くつくようになります。
この失敗のパターンが、このツールの名前の由来です。
ぬか床は毎日の手入れで熟成し、放置すると死にます。

`nuka tend` が答えるのはもう一つの問いです。
この語彙と、それが生み出した記録は、いまも健全か、です。

これが `check` への警告の追加ではなく別のコマンドである理由は、この 2 つが異なる瞬間に読まれ、異なる意味を持つからです。
`check` はあらゆる run の前に、CI の中で、agent のループの中で実行されます。
そこが出力する行はどれも、プロジェクトと green な run の間に立ちはだかるものです。
だからこそ、そこでの所見は立ち止まる価値があるものでなければなりません。
`tend` の所見はそうではありません。
ここにあるものはどれも今日直す必要はありません。
もしこれらの所見が毎回の `check` に現れたら、本当に直すべきだった行までみんなが読み飛ばすことを覚えてしまいます。
ノイズは、check を読む価値のあるものにすることを主張の中心に据えたツールにとって、見た目だけの問題ではありません。

所見を挙げる前に、`tend` はぬか床の現在の状態を示す 3 行のサマリーを出力します。
この 3 行のどれも所見ではなく、exit code も変わりません(移行の途中にあるスイートはそれ自体が異常な状態ではなく通常の状態であり、毎回それについて警告すれば、本当に対応が必要な所見を埋もれさせてしまいます):

- `scanned:` は、この run が実際に調べたすべてのディレクトリを名指しします。
  `featuresDir` と、各 `additionalFeatureDirs` エントリです(「Session、environment、secret」を参照)。
  最初に出力されるのは、件数はその範囲を読み手が知るまで何も意味しないからです。
- `bed:` は、語彙のうちどれだけが compat ではなく型付けされているかを示します。
  加えて、いくつの型付き step が `mutates: false`(読み取り専用)を宣言しているかも示します。
- `declared:` は、型付き step が宣言できることのうち、実際にどれだけが宣言されているか(`rationale`、各スキーマフィールドの `.describe()`)を示します。

このサマリーが存在するのは、この情報がすでにあったのに読まれていなかったからです。
step record の `world` と `declared` の件数は、スイートが昇格するにつれて確かに縮みます。
それは正確ですが、進捗を示す手段としては無意味です。
誰も、移行がどこまで進んだかを計算するために step record のディレクトリを読んだりしません。
ぬか床の健全さそのものを扱うコマンドの中で一度だけ述べることが、この情報を可視化します。

次の所見は、`tend` が何を調べているか、そしてそれぞれがなぜスタイルの問題ではなく腐敗なのかを示します。

- **もはや自分が凍結したコードと一致しない sign-off。** 記録は、受け入れた feature のソースと、その run のすべての step record を持ちます。
  凍結された `result` がその step の現在の `returns` スキーマをもはや通らない場合、あるいは凍結された feature のソースが元のファイルともはや一致しない場合、あるいはそれが引用する step が語彙から消えている場合、その記録はディスク上に残ったまま、もはや裏付けられない主張をし続けます。
  これは、ここでの所見のうち唯一、注記ではなくエラーになるものです。
  自分が述べている内容を静かに言い表さなくなった sign-off は、sign-off が無い状態よりも悪いです。
  なぜなら、それはまだ数に入れられ続けているからです。
  記録が名指す feature が `featuresDir` へ移った後は、これは一切チェックされません。
  以後は、走り続けるスイート自身が保証を担い、1 つの commit で凍結された記録は何も担いません。
  すでに無人で走っている feature へのふつうの編集のたびに警告が鳴れば、その警告は読まれなくなります。
  唯一の例外は、`tend` がそもそもパースできない記録です(前述の `signoff-record-unreadable`)。
  その `feature:` の値自体がパースできていない可能性があるため、置き場所で判定する手段がありません。
  記録のように見えて読めないファイルは、そのファイル自身についての事実であり、その主張がいまも成り立っているかどうかとは別の話です。
- **config からずれた、sign-off 自身が記録している条件。** sign-off は条件にスコープされています(「Sign-off」を参照)。
  条件とは `(environment, browser)` であり、どちらも計測値であって宣言ではありません。
  ある feature の直近の sign-off が、プロジェクトの config がもはや宣言していない browser を記録していても、その sign-off について今この瞬間に何か間違っているわけではありません。
  だからこそ、上の所見とは違い、これはエラーではなく注記です。
  この注記ができる前に accept された記録には、比較すべき条件がそもそも記録されていません。
  そのため、この所見は推測せずにその記録を対象から外します。
  上の所見と同じく、これも feature が `featuresDir` へ移った後は止まります。
  ずれている条件は、もう何にも依存されていない主張についてのものだからです。
- **import に失敗した step ファイル。** `tend` は `nuka check` と同じ寛容な step 発見を使います(「報告は寛容に、実行は速く失敗する」を参照)。
  壊れた glue ファイルは run を止める代わりにスキップされます。
  そのため、それが本来もたらしていたはずのものは、ここでのあらゆる件数と所見から静かに欠落します。
  何も失敗していないから欠落しているのではありません。
  run 全体で 1 件の注記であり、ファイルごとの 1 件ではありません。
  壊れたファイル自身の原因は `nuka check` 自身の所見(`step-file-import-failed`)です。
  そのため、この所見はただ何件の step が見えなかったかとそのファイル名だけを述べ、exit code には触れません。
- **何にも行使されない `from` 宣言。** その step があらゆる feature 内で出現するたびに、そのキーは行から直接キャプチャされます。
  そのため、宣言された生産者は一度も何も供給しません。
  これはただの事実として報告されます(その宣言は `nuka do --use` を通じてなお到達可能です)。
  削除すべきだという指示としてではありません。
- **どの feature からも束ねられていない pattern を持つ step。** CLI 専用のつもりの step は pattern を一切持つべきではありません。
  pattern を持っている場合、それは自分が占めていない scenario 上の場所を主張していることになります。
- **`.describe()` を持たないスキーマフィールド。** これは agent にまっすぐ狙いを定めた tending の所見です。
  agent がフィールドの意味を知る手段は `nuka describe` です。
  description のないフィールドは、名前がすでに伝えていた以上のことを何も agent に伝えません。
  step ファイルを読む人間は周囲のコードを見られます。
  しかし、2 つの step のどちらかを選ぶ agent にはそれができません。
- **`rationale` を持たない step。** `description` はその step が何をするかを述べます。
  それはその step を呼ぶには十分です。
  `rationale` はなぜこう作られているのか、何が却下されたのかを述べます。
  それは、agent がその step を書き換えてよいと決める前に必要とする情報です。
  それが欠けていれば、あらゆる書き換えは根拠を欠いたまま行われます。
- **どの pattern からも使われていない設定済みの parameter type。** これは使われていない設定であり、他のものと同様に報告されます。
- **support コード側にまだ登録されたままの `defineParameterType`。** それは動き続けます。
  `config.parameterTypes` がその typed 時代の住まいであり、登録をそちらへ移してもマッチは何も変わりません。
  これはかつて `nuka check` の warning でしたが、その分類は誤りでした。
  これは、スイートに compat が少しでも残っている限り現れ続けるものであり、それは正常な状態です。
  毎回の run の前にそれを出力すれば、人々に本当に run を止める行を読み飛ばすことを覚えさせてしまいます。
- **`secrets.public` または `secrets.redact` のエントリが、どの envFile も定義していないキーを名指ししているもの。** その指示は実在しますが、何にも届きません。
  自分が記述している対象のファイルから設定がずれているということです。
  これも同じ理由で `check` から移されました。
  この run を実行すべきかどうかは、これによって何も変わらないからです。
  その隣にある所見は `check` に残っており、対比する価値があります。
  値が短すぎて redact されない `redact` エントリと、secret らしいキーを持つ追跡済みの env file は、どちらも run が始まった瞬間に平文がログに届くことを意味します。
  それはまさに事前に知っておくべきことだからです。
- **設定された `additionalFeatureDirs` エントリがディスク上に存在しないもの。** これは `nuka check`/`nuka tend` がスキャンする範囲を広げるためだけに存在します。
  そのため、存在しないディレクトリは報告すべき config の誤りであり、それは `featuresDir` が欠けている場合と同じです。
  ただし `tend` には `check` が持つような config の誤り専用のエラー枠がありません。
  そのため、`nuka check` が同じ事実をエラーとして報告する一方で、ここでは注記になります。
- **`nuka check`/`nuka tend` がスキャンするどのディレクトリの外にもある、accept 済みの feature。** sign-off の記録は、その feature が green で走ったことをすでに証明しています。
  しかし、ここが一切歩かない feature は、それが結び付ける step を、このレポートの他のあらゆる所見に対して `pattern-unbound` のまま見せ続けます。
  sign-off の記録は、この所見の可視性のためだけに読まれます。
  何をスキャン対象にするかを決めるためではありません。
  スキャン対象をそこから広げてしまうと、少なくとも一度は accept されたことのある feature にしか気付けません。
  そして、まだ書きかけの feature を静かに見逃してしまいます。
  それこそ、誤った `pattern-unbound` がいちばん人を誤解させる feature です。
  そのディレクトリを `additionalFeatureDirs` に名指しすることが、実際にこれを直す方法です。
- **どの acceptance record にも一度も名指しされたことのない feature**(`feature-never-signed`)。
  上の所見の鏡写しです。
  あちらは record から出発して、それが正しい feature の集合を指しているかを問います。
  こちらはスキャン対象の feature 集合自身から出発して、その各メンバーに何か record が存在するかを問います。
  そのため、この 2 つが同じ理由で同じ feature に対して同時に出ることはありません。
  これは注記であり、エラーではありません。
  `nuka accept` は受け入れループの中で後から来る明示の step なので(「Sign-off」を参照)、まだ書きかけの feature にまだ sign-off が無いのは普通の状態です。
  それを壊れているものとして扱えば、進行中のあらゆる feature は完成する日まで赤いままになってしまいます。
  年数の閾値もありません。
  「一度でも sign-off されたか」には答えが 1 つありますが、「心配になるほど長いか」には発明した答えが必要になるからです。
  `featuresDir` の中にあっても、これは黙りません。
  上の sign-off の staleness の所見とは違います。
  あちらは、走っているスイート自身がかつて凍結された record が持っていた保証を運ぶようになった時点で黙りますが、record が一度でも作られたかどうかは別の問いであり、その feature がどこで走るかとは関係ありません。
- **step 自身の trace が、navigation の呼び出しのすぐ後ろに別の呼び出しが着地していることを示しているもの。** `tend` はこれを `.nukadoko/records/steps/` にあるツール自身の step record から読みます(「Records」を参照)。
  commit された sign-off の記録は accept した時点で凍結されたコピーを持ちます。
  そのため、run が計測したものをいまも運んでいるのは live な step record のほうです(「Sign-off」を参照)。
  これは、誰かが sign-off したかどうかを問わず、いまもディスク上に step record を持つすべての step に届きます。
  まだ誰も sign-off していない step も、それを走らせた run 自身の step record をすでに持っています。
  その step record 自身の `actions` にある `goto`・`reload`・`goBack`・`goForward` のそれぞれについて、その step が次に行った呼び出しまでの間隔を報告します。
  同じ step record 自身の `ctx.poll` の窓の中に着地する読みは除外されます。
  「Context API」の doctrine がすでに求めているとおり `poll()` を使って書かれた step は、構造上すでにリトライしています。
  これは、この所見が見分けようとしている対象そのものではありません。
  報告されるのは間隔そのものだけであり、判定ではありません。
  navigation の後にページが描画を終えるまでどれだけかかるかは、このツールには測りようがありません。
  どの Playwright の呼び出しが auto-wait するかを推測するテーブルも、作られていません。
  そのようなテーブルは、このツールが計測したものではなく依存先自身の意味論を書き写すことになり、その依存先が変わるたびに古びるからです。
  `actions` を一切持たない step record は、その step がブラウザに一度も触れなかったためであれ、そのフィールドが存在する前の記録であれ、静かに対象外のままになり、エラーにはなりません。

この最後の所見こそ、このリスト全体が `check` ではなく `tend` に属する理由をいちばん明確に示しています。
そこで名指しされる step はすでに run 済みであり、その step record はすでにその実行を計測しています。
今日それの何も壊れておらず、それによって止まる run もありません。
変わったのは、その実行がどのように起きたかについての事実をツールがいま見えるようになったことだけです。
その実行が本物でなくなったわけではありません。
`check` は run がいますぐ進めるかどうかに答えるために存在します。
そのため、すでに run 済みの step についてはもう言うことがありません。
`tend` はすでに run されたものがいまも健全かどうかに答えるために存在します。
「たまたま走っているレースにまだ負けていない」というのは、まさにその問いが扱う健全さの一種です。
これをエラーとして報告することは、まだ現れていない症状を、すでに現れたものとして扱うことになります。

所見は、他の出力と同じく `--json` に対応します。
sign-off の所見は非ゼロの exit code で終了し、定期実行されるジョブがそれに反応できるようにします。
残りの所見はそうしません。
プロジェクトはそれらを抱えたままでいることが許されているからです。

`tend` は報告するだけで、修復はしません。
直すということは、description を書くこと、step を削除すること、feature を再び accept することを意味します。
どれも背後に書き手がいる判断であり、これは `accept` が dirty な working tree を勝手に直さずに拒否するのと同じ理由です。

## CLI summary

npm パッケージは `nukadoko` で、それがインストールするただ 1 つのコマンドが `nuka` です。

```
nuka run <feature[:line]|dir>
                              execute scenarios; step records + allure-results.
                              :line runs one scenario, for iteration only. A
                              partial run can never be accepted. A directory
                              is walked recursively for .feature files, in
                              deterministic byte order, folded into this one
                              invocation: one run_id, one summary, one exit
                              code, one messages stream, one Allure results
                              tree. :line on a directory is refused, and a
                              directory with no .feature file anywhere under
                              it fails setup, naming what it walked. stderr
                              gets per-step/per-scenario progress as it runs,
                              then every location this run wrote and a summary
                              line; --quiet drops the progress lines only.
                              stdout stays NDJSON, one record per scenario,
                              always
nuka do <step> [--args '<json>'] [--use <step-record-id>]
                              execute one typed step; step record to stdout.
                              --args is required unless --use supplies
                              every key; --use fills its `from` keys
                              from an earlier execution's result
nuka harvest <step-record-id>...
                              turn a `do` sequence into one feature draft on
                              stdout: the lines and their order are measured,
                              the keywords are `*` and the names are
                              placeholders, because a claim is not in a step
                              record. What cannot become a line, what failed
                              when it ran, and what does not read back to the
                              record it came from are named in the draft and
                              on stderr. Provenance goes to stderr only. A
                              `nuka run` record is refused
nuka steps [--json]           list the whole vocabulary, typed and compat:
                              name, patterns, description, mutates, which
                              fixtures each step needs (needs, needs_browser,
                              or needs: null plus needs_error for the one it
                              can't read), and where each chained args key
                              comes from (from, or from_errors naming the
                              key and why for the one it can't read);
                              --json's top level is { steps,
                              import_failures }, the second always present,
                              exiting 1 if import_failures is non-empty or
                              any step's needs_error or from_errors is
                              present, output printed either way
nuka describe <step>          full contract, schemas as JSON Schema, plus
                              rationale when the step declared one, plus
                              import_failures beside it (same shape as nuka
                              steps' own); exits 1 when that array is
                              non-empty, or when the described step is typed
                              and carries its own from_errors; a broken
                              sibling step elsewhere in the vocabulary does
                              not fail it
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
nuka clean [--records] [--cache] [--export] [--dry-run] [--json]
                              delete accumulated records/cache/export under
                              the state directory; no category flag cleans
                              all three, one flag narrows to it; --dry-run
                              prints the same plan the real run would act on
                              without removing anything; refuses outright,
                              every category, while any session anywhere is
                              live; export/allure-history.jsonl is never
                              removed
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
                              directory, a feature no acceptance record has
                              ever named, a fixture no typed step requires,
                              a fixture reaching page/context
nuka session list|clear
nuka init [--base-url <url>] [--features-dir <dir>]
                              set up a project; ends with a self-check
nuka skill path               where the bundled skill lives, for a project
                              that wants the copy matching this nukadoko
nuka mcp-tools [--json] -- <command> [args...]
                              list the tools an MCP server declares over stdio,
                              connecting just long enough to ask. A separate
                              face from `nuka steps`; nothing this command
                              reports is ever part of that vocabulary
nuka experimental webmcp-tools <url> [--json]
                              EXPERIMENTAL, may change or disappear without
                              notice: list the WebMCP tools a page has already
                              declared via navigator.modelContext.registerTool.
                              The same separation from `nuka steps` that
                              `mcp-tools` draws, over a different protocol;
                              nested one command under `experimental` on
                              purpose, so the word is unavoidable at the call
                              site
```

テキスト出力(`--json` なし)は、端末で読む人間向けに整形されます。
`--json` が機械可読な契約です。

### 報告は寛容に、実行は速く失敗する

壊れた step ファイルへの反応は、この一覧の中で 2 通りに分かれます。
その分かれ目は 1 つの問いです。
そのコマンドはこれから step を実行しようとしているのか、それとも語彙を報告するだけなのか、です。
`nuka steps`、`nuka describe`、`nuka check`、`nuka tend` は報告する道具です。
それぞれがファイル単位で step を発見します。
そのため、import に失敗した 1 ファイルが、プロジェクトの残り全体がまだ見せられるはずのものまで空にしてしまうことはありません。
`nuka check` はその失敗を `step-file-import-failed` として名指しします。
`nuka steps`/`nuka describe` は同じ事実を(前述の)`import_failures` として運びます。
`nuka tend` は読めなかったファイルの周りで静かに数を減らす代わりに、`import-failures-unseen` という 1 件だけの note を足します(「Tending(手入れ)」を参照)。
`nuka run`、`nuka do`、`nuka init` はこれから step を実行しよう、あるいはこれから実行するプロジェクトを立ち上げようとしている道具なので、fail-fast のままです。
同じ壊れたファイルは呼び出し全体をそのまま拒否します。
なぜなら、その先へ進むことはこれから実行しようとしている何かにとって危険であり、報告するだけとは違うからです。
移行中のスイートにとって、glue の一部がまだ壊れているのは通常の状態です。
その状態でまったく動かなくなる報告の道具は、移行のダッシュボードとして役に立ちません。
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
  正直さとは、記録が語るのは常にただ 1 回の実行についてだけだということです。
  限界とは、欠陥のまるごと 1 つのクラスがどの 1 回の実行からも見えないということです。
- **このパッケージは ESM だけを出荷します。意図してそうしています。**
  `package.json` の `exports` は `import` の条件だけを持ち、`require` の条件はありません。
  ESM のビルドの隣に CommonJS のビルドは無く、増やす予定もありません。
  自分の `package.json` に `"type": "module"` が無いプロジェクトでも nukadoko は使えます。
  そのフィールドが何であっても曖昧さなく ESM として読まれるファイルを通して使います。
  設定は `nukadoko.config.mts`、step ファイルは `.mts` で、そのようなプロジェクトを見たときに `nuka init` と `nuka scaffold` が書くのはこの形です。
  したがって、どちらの場合も nukadoko を import するのは ESM の側であり、CommonJS のプロジェクトが得るのは入口であって、保守し続ける 2 つ目のビルドではありません。
  代償は実在し、それを払うのは既存のスイートです。
  そこで既に `.ts` として書かれている glue は、発見される前にリネームが要ります。
  これは compat の扉が本来求める「import 指定子 1 つ」より重く、リネームが要るファイルは `nuka check` が 1 つずつ名指しします。
- **step を `defineStep` に昇格させることは一方通行です。** compat の扉が約束するのは compat の資産についてだけです: import を元に戻せば、ただの cucumber-js スイートが残ります。
  `defineStep` には、切り替えて戻す import がありません。
  昇格させた step の body は移ります(`run` は Playwright 自身のオブジェクトに対して書かれており、それは下で述べているのと同じ選択によるものです)。
  けれどもそのスキーマ、step record の `result`、`from` とそれを読む束縛順序のチェック、そしてそれらの上に組まれたあらゆる契約チェックは移らず、ここには元に戻す手段は何もありません。
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

- **M1(engine core)**: `defineStep`、`do`、pickle に対する `run`、step record、session/environment、`check`、`init`。
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
- **M6(chained arguments)**: `from`、`nuka check` と `nuka run` が共有する scenario 順序チェック、`do` の `--use`、そして引用する step record の隣に step 名を記す `used` のエントリです。
  step の入力がどこから来るかは、`run` の本体の中の散文であることをやめ、ツールが読む宣言になります(「step の連鎖」を参照)。
- **M7(tending)**: `nuka tend`、壊れることではなく腐ることについての所見です(「Tending(手入れ)」を参照)。
  意図的に `nuka check` には含めていません: `check` はあらゆる run の前に読まれるものであり、立ち止まる価値があり続けなければならないからです。
- **M8(fixtures)**: `nukadoko.config.ts` 自身の `fixtures` の下に宣言するユーザー定義の資源です(「Fixtures」を参照)。
  完全な型付けのための `defineFixtures`、scope、step や scenario 自身の成否を運ぶ `use()` ベースの teardown、fixture ごとのタイムアウト、そしてそれらに付随する `check`/`tend` の所見です。
  typed 側にあった、compat の After hook にはなかった 1 つの gap を塞ぎます。
  受け入れ条件そのものではない片付けを置く場所です。
- **M9(parts)**: `defineStep` の `parts`、`call` fixture、step record が新たに持つ `calls` エントリ、そしてそれに伴う check です(「Parts」を参照)。
  feature ファイルを書き換えずに step を分割できるようになり、scenario の行より小さい粒度での再利用がそもそも可能になります。
- **M10(harvesting)**: `nuka harvest`、名指しされた `do` の一連の呼び出しから組み立てられる 1 つの feature の下書きです(「Harvesting(収穫)」を参照)。
  これは適応的なループを閉じる一手です: 探索によって見つかった経路が、1 つの文に固定された経路になり、それがここでゲートできる唯一の形だからです。
- **M11(live sessions)**: `nuka session start`/`stop`、プロセス内で開いたまま保持する 1 つの `ctx` です。
  これにより、`nuka do` はすでに途中まで進んだ world に降り立てます(「Live sessions」を参照)。
  ここより前のすべては何もない状態から始まっており、それは読み取りにとっては単に遅いだけですが、繰り返せない作業にとっては不可能を意味します。
- **Later**: AI 支援の glue コンバータ(既存の正規表現ベースの glue → 型付き step)、tag-expression によるフィルタリング、移行ではなくその場での共存が必要な実際のスイートのための cucumber-js アダプタ。

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
