# nukadoko 仕様

> nukadoko(あなたの Gherkin のための生きたぬか床): 型付きの step、step record、そして agent-first な CLI。

> 原文は spec.md。
> 相違があれば原文が正。

Status: M1(engine core)実装済み(`steps`/`describe`/`do`/`run`/`check`/`init`/`scaffold`、environment、secret)。
M2(compat、後述)も実装済み(`nukadoko/compat`、typed World の計測、移行ガイド)。
実世界での検証ゲートは、いまや両方とも実行済みです。
typed step を実際の feature ファイルに対して起草したゲートと、compat の扉を実際の cucumber-js の glue に対して監査したゲートです(後述)。
まだ 0.x で、M3 以降のうち Allure の result と messages ストリームはどちらも実装済み(`nuka report` が描き出します)であり、M5 の両方の skill も実装済みです。
`nuka check` における compat gap 検出(migration skill 自身の前提条件)も実装済みで(「Compat steps」と docs/migration.ja.md の「ダッシュボードは `nuka check`」を参照)、M1-M5 を締めくくります。

## nukadoko とは

nukadoko は Gherkin を実行する agent-first のエンジンです。
人間は、feature ファイルと型付き step 定義という耐久性のある成果物を書き、CI が投稿する run サマリとともに pull request でレビューします。
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
Examples の行が無い scenario outline は、その一つです。
`compile()` はプレースホルダを残すか、scenario 自体を実行から外します。
どちらも、境界が実行された結果ではありません。
`nuka check` はこれを `outline-does-not-run` として報告します。
行は feature ファイルに残します。
nukadoko はその行を生成せず、property test も実行しません。
判定そのものの property test は、検証対象のプロジェクトが、判定する関数に対して持ちます。
nukadoko が実行するのは、feature の Examples に書いた境界の行です。
2 つの形はエラーではなく警告です。
どちらも作者の意図どおりであることがあるからです。
自分の step に Given か When を持ち、Then を持たない scenario は `scenario-without-then` です。
その scenario は step がエラーなく動けば必ず通るので、どの step も結果を確かめていません。
Background の Then は、その scenario の Then に数えます。
`*` の行は Then でも Given でもなく、`*` の行だけの scenario は、Given を持つ Background の下でも対象外です。
Examples の行が 2 つ以上あり、名前に `<column>` を 1 つも含まない outline は `outline-rows-share-name` です。
どの行も同じ名前で動くので、run の要約には見分けのつかない行が並びます。

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
| 「何が何を証明するか」の承認と、それをどこに記録するか | チーム自身のプロセス(pull request のレビュー、CODEOWNERS、変更チケット、監査ログ) |
| **型付き step の契約** | **nukadoko** |
| **実行と計測(record)** | **nukadoko** |
| **Environment、secret** | **nukadoko** |
| **キーワードの意味論(Then は mutate してはならない)** | **nukadoko** |
| **run サマリ: 何が走ったかの証跡と、承認された基点からどの受け入れ基準と step ファイルが変わったか(比較が届く範囲で)** | **nukadoko** |

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

nukadoko が扱うものはすべて、4 つの種類のどれかに属します。
誰が書くか、リポジトリに属するか、どれだけの期間を想定するかによって種類が決まります。

| 目的 | 成果物 | 書く | コミット | 寿命 | 読む |
|---|---|---|---|---|---|
| Contract | `.feature`、step 定義、`nukadoko.config.ts` | 人 | する | 永続 | 人、エンジン |
| Measurement | `.nukadoko/runs/<run_id>/`、`nuka run` 1 回につき 1 つのディレクトリ(run の結果である `run.json`、その Markdown のサマリである `summary.md`、evidence を含む各 step record である `steps/<id>/`、scenario 自身の evidence を書いたときだけの `scenarios/<id>/`、run が parse した feature の本文である `sources.json`、`nuka report` がその run について書いた export ファイルの一覧である `exports`)と、`.nukadoko/do/<id>/`(`nuka do` の step record) | ツール | しない | 最新 `retention.runs` 回分の run。`nuka do` の record と終わっていない run は `retention.adHocDays` 日 | run をレビューする人(そのサマリ)、`nuka report`、`nuka do --use` |
| Export | `.nukadoko/export/allure-results/`、および `nuka report --out` が `.nukadoko/export/` の下に書くほかのファイル | ツール | しない | 描き出した run と同じ | 他のツール |

この表が名指しているのはファイルです。
列の間にある区別は、「これを消すと何が起きるか」と「誰がこれを変えてよいか」という 2 つの問いに答えます。

- **Export が使い捨てなのは、導出されたものだからです。**
  消しても、`nuka report` が run ディレクトリからもう一度描き出します。
  Allure の CLI や CI の formatter など、nukadoko の外側の読み手のために存在します。
  nukadoko 自身は決して読みません。
- **コミットされるのは Contract だけです。**
  Contract は人が書き、レビューした約束です。
  その約束が green で通ったかどうかは、CI が pull request に投稿する run サマリにあります(「レビュー」を参照)。
  それはリポジトリではなく、forge が pull request とともに保ちます。
  Measurement は決してコミットされません。
  `nuka init` は Measurement を置く state directory を gitignore します。
  1 回の run の作業記録は、次の run について何も語らないからです。
- **Measurement には寿命があり、`nuka run` がそれを守らせます。**
  単位は run ディレクトリ 1 つ丸ごとです。
  run は計測したものすべてとともに消え、保たれた run の中のものが単独で消えることはありません。
  毎回の run の終わりに、最新 `retention.runs` 回分(既定 20)の run が保たれます。
  終わった run とは、終わったときに書いた `run.json` を持つ `runs/<run_id>/` のことで(「Scenario(スクリプト化された経路)」を参照)、その `started_at` で日付を持ちます。
  `nuka report` が最新の run を名指すときの規則と同じなので、両者が「どの run か」で食い違うことはありません。
  それより古い run ディレクトリは丸ごと消え、その run 自身の `runs/<run_id>/exports` が列挙する export ファイルと messages ストリームも一緒に消えます。
  読めない `run.json` や、`started_at` を日時として解釈できない `run.json` は、どの run の日付にもなりません。
  まだ書いている可能性のある run は順位付けされません。
  実行中の run や強制終了された run には、run.json として読める `run.json` がなく、終わったと証明できないものは消しません。
  そのような run ディレクトリは、mtime で日付を持ち、下の日数の規則に任されます。
  retention を適用する run 自身は、より新しい run が先に終わっていても、自分の適用で消されることはありません。
  `nuka do` の record(`do/<id>/`)と `run.json` のない run ディレクトリは、`retention.adHocDays` 日(既定 7)より古くなった時点で消えます。
  `nuka do --use` は設計上、日をまたいで `do/` の record を読むため、run の回数ではなく日数を与えています。
  寿命を過ぎた record への `--use` は、有効な方針を添えて拒否され、何も返さないまま終わることはありません。
  どちらの数字にも「無効」の値はなく、履歴を長く持ちたいプロジェクトは数字を上げます。
  既定値は判断です。
  これまでに測った最も重いスイートは run 1 回あたり約 50 MB なので、20 回で約 1 GB です。
  それより少ないと、数分おきに走るスイートでは 1 時間前に追っていた失敗が消えてしまいます。
  export ファイルは、run 自身の一覧を通してだけ消され、古さで消されることはありません。
  results ディレクトリは他のツールの Allure 出力と共有されることがあり、nukadoko が書いていないファイルは nukadoko が消してよいものではないからです。
  manifest の行は、symlink も含めて解決して `export/` の中のファイルになるときだけたどり、manifest 自体も、symlink ではない run ディレクトリのファイルであるときだけ読みます。
  よそからコピーした run ディレクトリに、プロジェクトのファイルを消す対象として名指させないためです。
  その行は、`nuka report` が書きえたものを名指す必要もあります。
  それは、ディレクトリでも symlink でもない通常のファイルで、大文字小文字やディレクトリの別名を問わず `allure-history.jsonl` という名前ではないものです。
  retention はそれ以外の行を飛ばし、古い run を消し続けます。
  `nuka clean [--dry-run] [--json]` は、カテゴリ丸ごとを消す操作として残ります。
  3 つのカテゴリをまとめて消します。
  `--dry-run` は実際の run と同じ計画を出力しますが、何も消しません。
  `nuka report --out` が state directory の外に書いたレポートは呼び出し側のファイルであり、`clean` は読みも消しもしません。
  `export/` の下で `clean` が消すのは、run の manifest が名指すファイルと `allure-results/` の中身だけです。
  `export/allure-history.jsonl` は `allure-results/` の中ではなくその隣にあるので、retention も `clean` も消しません。
  ここにある成果物のうち、新しい run で再現できないものはこのファイルだけです。
- **step record と run.json は同じ 1 行にいます。**
  違うのは粒度だけです。
  `run.json` の中の scenario のエントリと各 step record は、異なる 2 つの問いではなく、同じ問いに 2 つの解像度で答えます。
  `nuka do` には書く対象の scenario も run もないため、step record だけを書きます。
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
`.d.ts`、`.d.mts`、`.d.cts` は step 定義ではなく型宣言であるため、対象から除外します。

discovery も、`.feature` ファイルを歩く処理も、シンボリックリンクをたどります。
そのため monorepo は、共有の step や feature を `featuresDir` にリンクできます。
どの処理も、各ディレクトリには一度だけ入ります。
そのため、ツリーの上を指すリンクがあってもループせず、同じディレクトリを指す 2 つのリンクがあってもファイルを二重に並べません。
`featuresDir` と `additionalFeatureDirs` から複数の経路で届く feature は、一度だけ読みます。
ファイルは実パスで区別し、最初に届いた経路の名前で報告します。
リンク先が存在しないリンクも、歩く対象に残ります。
その import や読み込みが失敗し、その失敗がリンクを名指しします。

discovery は `.cjs` と `.cts` のファイルを特定しますが、インポートしません。
どちらの拡張子も定義上 CommonJS であり、nukadoko は ESM-only です。
同じ CommonJS の go/no-go については、後述の「Compat steps」を参照してください。
`nuka check` は、そのファイルを `step-file-unsupported-extension` として報告します。
この報告により、そのファイルの定義が説明のつかない `undefined-step` として再び現れることを防ぎます。

config と step ファイルは、Node 自身が型の除去で読み込みます。
Node は型注釈を空白に置き換え、残りを実行します。
そのため Node の下限は、これをフラグなしで行う最初のリリースです(22 系は 22.18、それ以外は 23.6)。
ここから 4 つの規則が出てきます。

- step ファイルは、別の step ファイルを `.ts` まで含めたファイル名で import します(`import createProject from "./create-project.ts"`)。
  `nuka scaffold --from` が書くのはこの綴りで、素の `node` が解決できるのもこの綴りです。
  ただし `tsconfig.json` が `extends` の連鎖を通しても下の 2 つのオプションのどちらも true にしていないとき、`scaffold --from` は代わりに `.js` の名前を書き、そのことを stderr の 1 行の `note:` で伝えます。
  こうして書いたファイルは、プロジェクト自身の `tsc` をそのまま通ります。
  連鎖の中に読めないファイル(パースできないファイル、どのファイルも指さない `extends`)があるときも `.js` の名前になり、`note:` がそのファイルと理由を示します。
  `tsc` は `rewriteRelativeImportExtensions` か `allowImportingTsExtensions` があれば受け付けます。
  `tsconfig.json` がどちらも指定していないとき、`nuka init` は前者を追加します。
  そのとき `init` は `extends` をたどります。
  継承元のファイルがどちらかのオプションを名指していれば、それがプロジェクトの選択です。
  オプションが `extends` を通してだけ届くとき、`init` は新しい `compilerOptions` を書きません。
  代わりに、継承の連鎖のどのファイルもどちらのオプションも設定していないこと、またはそのどれかを読めなかったことを stderr に書きます。
  `"module": "nodenext"` で TypeScript が書く `.js` の綴り(`create-project.ts` に対する `./create-project.js`)も、`nuka` の下では引き続き読み込めます。
  `.js` ファイルが無いときに `nuka` が `.ts` ファイルを試すからです。
  ただし素の `node` で実行するプログラムでは読み込めません。
- 実行時の振る舞いを持つ構文は読み込めません。
  `enum`、`namespace`、コンストラクタのパラメータプロパティです。
  `nuka check` はそのファイルを、Node が示す行で `step-file-import-failed` として報告し、書き換え方を示します。
  `"erasableSyntaxOnly": true` を設定すると、`tsc` が同じ構文を報告します。
  Node 23.x のこの報告はファイルを示しません。
  step ファイル自身の型の除去が失敗するときは、行は Node が示すものです。
  Node はファイルの型を、それが import するファイルより先に除去するからです。
  そうでないとき、finding は行を持たず、エラーは step ファイルが import するモジュールの中にあると伝えます。
- `type` なしで import した名前は、型の除去の後も import として残ります。
  そのため型をこの形で import すると、Node の "does not provide an export named" エラーで失敗します。
  `import type` を使えば避けられます(`"verbatimModuleSyntax": true` にすると `tsc` がそれを求めます)。
  その名前が `nukadoko`、`nukadoko/compat`、`nukadoko/matching` が export する型(`IWorldOptions` など)のとき、finding は `import type` と書くよう伝えます。
  それ以外のモジュールについては型と書き間違いを区別できないので、何も足しません。
- `"type"` のない `package.json` のもとでは、Node は `.ts` や `.js` のファイルを 2 回解析し、読み込むたびに `MODULE_TYPELESS_PACKAGE_JSON` の警告を出します。
  ファイルは読み込めるので、`nuka check` はこれを注記 `package-type-missing` として報告し、`"type": "module"` を追加すべき `package.json` を名指します。

discovery は 1 回ごとに、それ自身のモジュールグラフでファイルを読み込みます。
そのため 2 回 discovery を行うプロセス(テスト、実行中のプロセスの下で編集された config)では、各ファイルのトップレベルのコードが再び実行され、2 回の discovery がモジュールを共有することはありません。

リポジトリのルートなどを `featuresDir` に設定すると、同じように歩く範囲が広がります。
その木の中にあるビルド成果物も、名前が上記 4 つの拡張子のいずれかで終わる場合は glue になり得ます。
`node_modules` とすべてのドットディレクトリは、`featuresDir` の設定にかかわらず除外されます。

広い設定は、`nuka check` が見つけるものだけでなく、その動作も変えます。
discovery は歩いた各ファイルをインポートします。
そのため、モジュールは本来読み取り専用のコマンド中に環境を読み、接続を開き、ファイルを書けます。
`featuresDir` がアプリケーションと glue の両方を含む場合、discovery はアプリケーションのトップレベルのコードを実行します。
scenario がプロセスとして実行するファイル(偽のサーバ、fixture のスクリプト)は、同じ理由で `featuresDir` の外に置きます。
discovery は `nuka check` のたびにそれを import し、トップレベルで子プロセスを起こしたり socket で listen したりするモジュールは、そこでそうしてしまうからです。

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
  1 つの pattern の中で同じキーが 2 回キャプチャされるのはエラーです。
  args の 1 つのフィールドが持てる値は 1 つであり、最後のキャプチャだけを残すと、それより前の値が黙って落ちるからです。
  `nuka check` はその pattern を報告し、`nuka run` は step 本体を呼ぶ前にその結び付きを拒否します。
  どちらもそのキーを名指しします。
- pattern のリテラル部分も自由な散文ではなく、それ自体が cucumber-expressions の構文です。
  裸の `(` `)` は optional text、裸の `/` は alternation を意味するため、リテラルとして書きたい場合はエスケープしなければなりません。
  `pattern` の文字列リテラルの中では `\\(` `\\)` `\\/` と書きます(パースされた式の中の 1 つのバックスラッシュは、TS のソースでは 2 つになります)。
  スキーマの不一致と違い、エスケープを忘れてもビルドは成功し、step も登録されます。
  そして pattern は、それが書かれた対象の pickle のテキストに一切マッチしなくなります(検証で 2 つの独立した corpus がこれを踏みました)。
  `nuka check` は黙っていません。
  pattern をエスケープすればマッチする feature の行は `undefined-step` として報告され、step の名前とエスケープを示すヒントが付きます。
  中身のない裸の `()` は、それ自体が `pattern-syntax-error` です。
  どの feature の行も使わない pattern は報告されません。
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
  組み込みキャプチャの JS 型と、number・string・boolean・bigint のスキーマとの食い違いは、スキーマがキャプチャした値を型強制しないときだけ報告されます。
  組み込みキャプチャの JS 型は、`{int}` `{float}` `{double}` `{byte}` `{short}` `{long}` が number、`{word}` `{string}` 無名の `{key:}` `{bigdecimal}` が string、`{biginteger}` が bigint です。
  pipe と transform は入力側で判定します。
  union、`z.any()`、preprocess、カスタム parameter type は報告しません。
  `z.coerce.number()` は `{string}` を受け入れ、`z.coerce.string()` は `{int}` を受け入れます。
  その値がパースできるかどうかは実行が決めることなので、静的チェックはそこでは沈黙します。
  スキーマのキーを持たないキャプチャはエラーです。
  ある行の何によっても埋まりようのない **required** なスキーマキーも同様にエラーです(キャプチャも table/docstring も `from` もない)。
  その行は args のバリデーションに失敗する以外にありえないからです。
  この逆方向は、キーが何かツールに見えない方法で埋まっているかもしれないという理屈のもと、しばらく未チェックのままでした。
  `from` が残る方法を可視化することでその隙間を埋めたため、残っているのは単に説明されていないだけでなく、正真正銘埋まりようのないものです。
  table は `string[][]`、docstring は `string` としてキーに届くため、素の string キーに付けた table、または array、number、boolean、object のキーに付けた docstring は `table-docstring-key-mismatch` として報告されます。
  table を付けた array キー、coerce するスキーマ、pipe、transform、union は沈黙します。
- pattern、table/docstring、`from` のどれも埋めず、しかもスキーマが宣言していない args キーは、`nuka describe` がそのスキーマについて公開する契約に従います。
  `nuka describe` は各オブジェクトの `args` スキーマを `z.toJSONSchema` で公開します。
  素の `z.object(...)` は `additionalProperties: false` になり、step の `args` をバリデーション済みの値に変える経路はすべて、同じ閉じた形に対してパースします。
  対象は `nuka do`、`nuka run`、part が呼ばれる `call` fixture です(「Parts」を参照)。
  宣言していないキーは、黙って捨てられるのではなく拒否されます。
  `nuka describe` はその閉じた args スキーマを、呼び出し側が渡さなければならない入力として描きます。
  そのため `required` に載るのは、呼び出し側が省略できないキーだけです。
  `.default(...)` を持つキーは `required` に入りません。
  `returns` は出力のスキーマのままです。
  default 付きのキーは `returns` では required のままです。
  step が返した値には、そのキーが必ず含まれるからです。
  余分なキーをどう扱うかをすでに述べているスキーマ(`z.looseObject`、`.passthrough()`、`.catchall(...)`)は、その catchall つきで公開されます。
  `additionalProperties` は `{}` か、catchall 自身のスキーマです。
  同じ経路はその catchall をそのまま残します。
  閉じた形に強制すると、公開済みの契約が許しているキーを拒否することになります。
  `from`/`--use` が埋めるキーは決して指摘されません。
  どちらも、その step 自身が宣言したキーしか名指せないからです。
  成功した record の `args` は検証済みの値そのものなので、スキーマ自身の `.default(...)` が埋めたキーは、その行で誰も書いていなくても現れます。
  失敗した record は与えられたものをそのまま保持します。
  読み手が生の値をもっとも必要とするのがそこだからです。
  part 自身の `CallEntry.args`(「Records」を参照)は、どちらの結果でも生のままです。
  ここで変わったのは何を受け入れるかであり、何を書き残すかではありません。
- step に付いた data table や docstring は、名前付きキャプチャも `from` の宣言も引き受けていない唯一の必須 args キーに結び付きます(table は `string[][]` として、docstring は `string` として)。
  だから 1 つの step が、同じ行で 1 つのキーを前の step から、もう 1 つを添付から受け取れます。
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
- `returns` は省略できます。
  省略すると空のオブジェクトの schema がデフォルトになり、何も返さない `run` は `{}` として記録されます。
  これは、後の step が引用するものも、失敗の診断に使うものも持たない step に向いています。
  典型的には、観測した値がすでに `from` を通じて args として届いている Then の step です。
  何かを観測する step は、それを返すことに変わりありません(前述)。
  キーを持つオブジェクトを返す `run` は、そのキーを挙げる `result_invalid` で step を失敗させます。
  そうしなければ record には `{}` が残り、step が通る一方で値が失われるからです。
  `returns` を宣言した step の意味は変わりません: `run` はその schema が検証する値を返し、何も返さなければ step は失敗します。
  そのときのメッセージは、`run` が何も返さなかったと述べます。
  値が Promise であるキーには、`run` の中の呼び出しに `await` が要ることが添えられます。
- `run` の本体は、自分が分割代入した fixture の上で自由に書ける TypeScript です。
  合成とは、別の step モジュールをインポートし、同じ fixture bag でその `run` を呼び出すことです。
  共有ヘルパーは通常のモジュール(例: `features/steps/lib/`)に置きます。
- 意味的な正しさ(実装が description と pattern の主張どおりに動くかどうか)は、ツールではなく PR レビューによって保証されます。
  `steps/` は CODEOWNERS で保護してください。

### Context API

step の `run` は、素の分割代入パターンで **fixture bag** を受け取ります: `run({ page, section }, args)`。
名前はアルファベット順に並べます。
executor は、step が分割代入した fixture だけを構築します。
step が `page`、`context`、`pageAs` のどれも名指さなければ、その step のためにブラウザを起動しません。

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

- `page: Page`: `config.browserContext` から作った新しい browser context の Playwright の Page です。
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
- `await pageAs(name, options?)`: `page` と同じブラウザの中にある、`name` という名前の専用の browser context の `Page` です。
  cookie と storage はその context だけのものなので、cookie で人を覚えるアプリに対して、1 つの scenario の 2 人は 2 人のままです。
  `options` はその 1 つの context のための Playwright 自身の `BrowserContextOptions` で、たとえば `{ javaScriptEnabled: false }` です。
  `config.browserContext` の上に適用されます。
  `baseURL` は `page` と同じように渡されます。
  `config.browserContext` の `storageState` は渡されません。
  その context は別の人だからです。
  context は scenario の中でその `name` が最初に呼ばれたときに開き、後の呼び出しは同じページを返します。
  後の呼び出しが別の `options` を渡すと `ContextOptionsConflictError` を投げます。
  Playwright は context を作るときにオプションを固定するので、2 つ目のオプションは無視するしかないからです。
  比較には最初の呼び出しのときのオプションを使い、値が `undefined` のキーは無いものとして扱います。
  `name` は小文字、数字、ハイフンの 1 文字から 64 文字で、先頭は文字か数字です。
  名前がファイル名の一部になるからです。
  それ以外の名前は `InvalidContextNameError` を投げます。
  context は、返されたページの `page.context()` です。
  `pageAs` を分割代入しても何も起動しません。
  起動するのは最初の呼び出しです。
  後述の「1 つの scenario の複数の人」を参照してください。
- `request: APIRequestContext`: `config.requestContext` から作った Playwright の APIRequestContext です。
  上の `page` と同様に、`baseURL` は任意です。
  複数のホストに絶対 URL だけでアクセスするスイートには、指定する単一の baseURL がありません。
  nukadoko は、この fixture を満たすためだけに baseURL を config へ強制しません。
  `baseURL` が未設定の状態で step が相対パスを渡すと、Playwright がエラーを発生させます。
  nukadoko は、そのエラーを先に防ぐために Playwright の URL 解決を再実装しません。
- `env`: 設定された envFiles から得た読み取り専用の環境変数です。
  ファイルの形式は「Environment、secret」にあります。
  この fixture は決定論を強制します: プロセス環境は決してマージされません。
  secrets の redaction も強制します: redact できるのは nukadoko がロードした値だけです。
  これは便利機能ではありません。
  step が受け取るオブジェクトは、そのマージ済みマップをコピーして書き換え不能にしたものです。
  プロパティへの代入は失敗します。
  step モジュールは strict なので、その代入は TypeError を投げます。
  そのため、ある step での書き込みは、後の step からも後の scenario からも見えません。
  設定済みのキーを読むと、ロードされた値が返ります。
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
  この予算は、実行中の試行を含みます。
  予算が尽きた時点でまだ完了していない試行はそこで終わり、その後に届いた値は返り値になりません。
  `timeout` と `interval` は、どちらも 0 より大きい有限のミリ秒でなければなりません。
  省略したときは既定値を使います。
  `timeout` の既定値は 30000、`interval` の既定値は 500 です。
  `NaN`、`Infinity`、0、負の数は、最初の試行の前に `InvalidPollOptionsError` を投げます。
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
  これは、Allure の result が `declared:` 接頭辞で示す、自己申告と計測の間の同じ境界です(「Allure results」を参照)。
  ここでは、その境界が、ツールが計測した待機と Playwright 内で見えずに発生した待機を分けます。
- `evidence.attach(name, body)` / `evidence.path(name)`: 他の fixture が扱わない唯一の不足を埋めます。
  上の他の fixture はすべて、harness が自分で収集するものを返します。
  以前は、step だけが生成できるアプリ固有の証跡を受け取る fixture がありませんでした。
  たとえば、DB のスナップショット、子プロセスが scratch のディレクトリの外に書いたファイル、http.jsonl が残す 16 KiB を超えたレスポンス本文の全体です。
  `attach` は `body`(`string | Uint8Array`)を、この実行自身の evidence directory に書き込みます。
  このファイルを step record の `evidence.attachments` に記録します(「Records」を参照)。
  同じ `name` で 2 回呼ぶと、最初のファイルを上書きせず、両方のファイルを残します。
  大文字小文字だけが違う `name` も、この目的では同じ名前です。
  2 回目の呼び出しには同じ接尾辞が付き、大文字小文字を区別しないボリューム上で 1 つのファイルに重なりません。
  `path` は Playwright 自身の `testInfo.outputPath()` です。
  何も書き込まずに、同じ directory の下へ衝突しない絶対パスを割り当てます。
  step record に載るのは、実行が終わる前に step が書き込んだパスだけです。
  `path()` の呼び出し後に書き込まなければ、何も追加されません。
  両方のメソッドが 1 つのオブジェクトにあるのは、executor から同じ情報を必要とするからです: この step 自身の evidence directory です。
  step が一方のメソッドを必要とする頻度は、もう一方を必要とする頻度とほぼ同じです。
  パス区切りを含む `name` は拒否されます。
  `.`、`..`、空文字列のいずれかと等しい `name` も拒否されます。
  `record.json`、`final.png`、`trace.zip`、`http.jsonl` と等しい `name` も拒否されます。
  `process-<n>.stdout.txt`、`process-<n>.stderr.txt`、`process-<n>.stdin.txt`、`process-<n>.json` という形の `name` も拒否されます。
  大文字小文字だけが違う綴りも同じです。
  それらは harness がその directory に自分で書くファイルであり、step の名前がそこに重なるとそのファイルを置き換えるからです。
  拒否は `ReservedEvidenceNameError` です。
  nukadoko は、これらの名前を黙って書き換えません。
  step が要求していない名前を信頼するよりも、その呼び出しで明確なエラーを出す方が適切です。
- `scratch.dir(prefix?)` / `scratch.copy(source)`: step が自由に書き込める一時ディレクトリです。
  `dir` は OS の一時ディレクトリの下に空のディレクトリを作り、その絶対パスを返します。
  名前は `prefix`(既定は `nukadoko-scratch`)で始まります。
  パス区切りを含む prefix は `InvalidScratchPrefixError` を投げます。
  `copy` は `source` を新しいディレクトリにコピーし、そのディレクトリを返します。
  ディレクトリの中身はその直下に置かれ、ファイルはそのファイル自身の名前で置かれます。
  相対パスの `source` はプロジェクトのルートを基準に解決されます。
  どのディレクトリも、scenario が終わるときに、成功でも失敗でも削除されます(`nuka do` では実行が終わるときです)。
  step record は、それぞれを `evidence.scratch` に記録します(「Records」を参照)。
  片付けが executor の役目なのは、scenario が終わったことを知っているのが executor だけだからです。
  step が自分でディレクトリを削除すると片付けが scenario に入り込み、削除を忘れると漏れます。

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

#### 1 つの scenario の複数の人

受け入れ条件には、2 人以上の人が出てくるものがあります。
主催者と参加者、買い手と売り手などです。
それぞれが自分の端末から操作し、アプリは cookie でその人たちを区別します。
`context.newPage()` は同じ cookie の入れ物の中に 2 枚目のタブを開くので、2 人目の人を演じられません。
`pageAs(name)` は、2 つ目の context に至る計測された経路です。
executor はそれを自分が起動したブラウザの中で開き、デフォルトの context が持つ購読をすべて付けるので、同じ step record に記録されます:

- `"as": "<name>"` を持つ http.jsonl の行
- `as` を持つ `page_events` のエントリ
- `pageAs(name)` を呼んだ step または hook ごとに 1 つの trace チャンク
  `trace.zip` の隣に `trace.<name>.zip` として書かれ、`evidence.named_traces` に載ります。
  その `actions` はデフォルトの context の `actions` と 1 つのタイムラインに並び、それぞれが `as` を持ちます。
- scenario の `evidence.screenshots` に `as` 付きで載る最終スクリーンショット `final.<name>.png`

context は scenario の終わりに、スクリーンショットを撮った後で閉じ、ブラウザはその後で閉じます。
チャンクは、step がその名前を最初に呼んだときに開きます。
これは `page` と同じ遅延の規則です。
`pageAs("aki")` を呼ばない step には、aki のページが前の step から開いたままでも `trace.aki.zip` はありません。

ほかに 4 つの形を検討し、拒否しました。
`ctx.page({ as: "aki" })` は `page` を値から関数に変えるので、それを分割代入するすべての step が壊れます。
また、typed step には `ctx` がありません。
`browser` fixture は上で拒否しています。
人ごとの context を `nukadoko.config.ts` で宣言すると、scenario の人がプロジェクトの設定に入り、新しい人が feature ファイルの 1 行ではなく設定の変更になります。
1 つの context の中で人ごとにホスト名(`aki.localhost`)を与えるプロジェクトの fixture は、cookie をホストごとに分けるアプリでしか働かず、スクリプトを止めるにはタブごとに DevTools Protocol の呼び出しが要り、どの step も名指す前にアプリを操作する fixture でもあります。
`pageAs` が名前を実行時に受け取るのは、人が scenario のデータであり、分割代入パターンに列挙できるものではないからです。
それでも `pageAs` を分割代入することが、`check` が読む静的な宣言です(`needs_browser`、`playwright-missing`)。

`check` は `pageAs` そのものについての finding を追加しません。
名前は step の本体の中の引数で、`check` はそこを読まないので、間違った名前を実行前に知ることはできません。
run がその呼び出しで拒否します。

2 つの形、デフォルト値を持つ分割代入された fixture(`{ page = ... }`)と rest プロパティで集める fixture(`{ ...rest }`)は、誤って部分的に解析されず、そのまま拒否されます。
どちらもこの節の冒頭で述べた静的な読み取りを損ないます: デフォルト値は `check` が明確に読める名前を壊し、rest プロパティが束縛する名前は分割代入を実行しなければ分からず、`check` は実行してはいけません。
どちらを拒否しても、fixture が正当に必要とするものは失われません: fixture は名指された時点で必ず存在するため、デフォルト値が使われることはなく、step が必要とする fixture はすべて明示的に名指せます。
`check` と `nuka run`/`nuka do` はこの判定を共有するため(「step の連鎖」で `from` に使う「一つの判定を 2 つの呼び出し元が共有する」形と同じです)、step が `check` を通過して実行時に拒否されることも、その逆もありません。
未知の fixture 名、デフォルト値、rest プロパティは、いずれも実行前に実行そのものを拒否し、未定義の step と同じ「開始しなかった」という結果になり、step の失敗にはなりません。

未知の名前がその step 自身の args のキーであれば、同じメッセージが直し方を示します: args は `run` の第 2 引数なので、fixture を必要としない step は `run({}, { sum })` と書きます。
args だけを受け取る引数 1 つの `run` はありません。
引数 1 つの `run({ page })` はすでに「`page` を必要とし、args を取らない step」を意味しており、TypeScript は 1 つの引数位置を fixture bag と args のどちらとしても型付けできません。

この読み取りは `check` の外にも公開されます: `nuka steps --json` は、各 typed step が分割代入した名前を `needs` として報告し、名前をアルファベット順に並べ、何も必要としないときは `[]` を返し、`page`、`context`、`pageAs` のどれかを含むかを `needs_browser` で示します。
そのため agent は scenario を選ぶとき、実行前にブラウザを開かない step を識別できますが、ブラウザを使う scenario には API だけの scenario にはない分単位の時間と実物のターゲットが必要です。
同じ静的な読み取りが解析できない `run()`、つまりデフォルト値、rest プロパティ、または分割代入パターンの位置に裸の識別子がある場合、`needs` は `[]` ではなく `null` になり、そのエントリの `needs_error` が理由を示し、導けないブラウザ要否を主張しないため `needs_browser` もありません。
その step 自身の name、patterns、description は引き続き報告されるため、一つの読めない `run()` が残りの一覧を失わせることはありません。
呼び出しのトップレベルは step のベタな配列ではなく、すべての `--json` が出力する envelope で、`steps` は `findings` の隣にあります。
`step-file-import-failed` の所見(`file` と `message` を持ちます)は import に失敗したすべての step ファイルを名指しし、失敗がなければ `findings` は `[]` です(下の「報告は寛容に、実行は速く失敗する」を参照)。

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
含まれるのは、`page`、`context`、`pageAs`、`request`、`env`、`requireEnv`、`baseURL`、`resultOf`、`call`、`section`、`poll`、`evidence`、`scratch`だけです。
`page`、`context`、`request` は Playwright 自身のオブジェクトで、`pageAs` はそれを返し、`playwright` はこのパッケージの optional な peer dependency です。
プロジェクトがそれをインストールするのは、step か fixture がこの 4 つのどれかを使うときだけです。
パッケージが読み込まれるのはそのどれかが初めて構築されるときで、コマンドの開始時ではないので、`nuka init`、`nuka check`、そうした step の無い run はそれ無しで動きます。
それが無いときは、fixture の構築が step を失敗させ、その step とコマンド `npm install -D -E playwright@<version>` を名指す 1 行を出します。
`nuka check` は同じ行を先に error `playwright-missing` として報告します。
対象は、check する feature の行が束縛する step のうち、fixture が直接か `config.fixtures` を通して `page`、`context`、`pageAs`、`request` を構築するもので、step ごとに 1 回です。
check は run が読み込むのと同じ方法で `playwright` を解決し、何も構築しないので、`nuka run` はどの step も実行する前に止まります。
step ファイルに定義されていても、check する行のどれも束縛しない step は報告しません。
`playwright`、`playwright-core`、`@playwright/test` を自分で import する step ファイルは、そのパッケージが無いと import そのものに失敗します。
`nuka check` はそのファイルも `step-file-import-failed` ではなく `playwright-missing` として報告します。
インストール行はそのファイルが import するパッケージのもので、メッセージはどのファイルでも同じなので、テキスト出力ではそれらを 1 つのグループと 1 つのインストール行にまとめて出します。
プロジェクトの別のファイル(ヘルパーや別の step ファイル)を通してそのパッケージに届く step ファイルも、同じインストール行で同じように報告します。
そのメッセージは、パッケージを import しているファイルを名指します。
`node_modules` の中からの import は Node 自身のメッセージのままです。
インストール済みのパッケージが自分の依存を見つけられないのはインストールが壊れているためで、このインストール行で直るとは限らないからです。
check を実行せずに step ファイルを import するコマンド(`nuka run --no-check`、`nuka do`、`nuka steps`、`nuka describe`)も、そのファイルを同じメッセージで報告します。
`nuka run --no-check` と `nuka do` は、インストール行を `do:` 行に出します。
これはシェルがそのまま実行できるコマンドです。
型宣言も同じ規則に従います。
この 3 つの型は、`playwright` がインストールされていれば Playwright 自身の型で、無ければ `any` です。
そのため、プロジェクト自身の `tsc` は、`skipLibCheck: false` でもそれ無しで通ります。
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
`env`、`section`、`poll`、`resultOf`、`call`、`evidence`、`scratch`、その他の nukadoko 固有名を分割代入する fixture を Playwright の runner は理解しません。
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

プロジェクトの fixture を分割代入する step には、その fixture の型も必要です。
step の `run` は `FixtureBag` を受け取ります。
プロジェクトは `nukadoko.config.ts` で `StepFixtures` を拡張して、fixture をそこに加えます:

```ts
declare module "nukadoko" {
  interface StepFixtures {
    tenant: Tenant;
  }
}
```

`tsc` にはこの拡張が必要です。
これがないと、`tenant` を分割代入する step は `Property 'tenant' does not exist on type 'FixtureBag'` で失敗します。
`nuka check` は fixture の名前をソーステキストから読むので、この拡張を必要としません。

fixture は step と同じ方法で第一引数を分割代入します。
`check` は fixture を呼ばずに、ソーステキストから fixture の依存名を読みます。
step の依存も同じ方法で読みます。
fixture は builtin の依存として `page`、`context`、`pageAs`、`request`、`env`、`requireEnv`、`baseURL` を名指せます。
scenario fixture は、加えて `resultOf`、`section`、`poll`、`evidence`、`scratch` を名指せます。
これらは、その fixture を構築させた step の記録に載り、step の境界が開いている必要はありません。
`call` はこれらに含まれません。
fixture は依存の構築中に実行され、その時点では step の境界はまだ開いていません。
`call` はその境界を読むため、fixture が `call` を名指すと例外を投げるしかありません。
`check` はこれを `fixture-structural-violation` として報告します。
`nuka run` と `nuka do` は、未知の fixture 名と同じく、どの step も始まる前にこれを拒否します。
fixture は別の `config.fixtures` エントリも名指せます。
解決は Playwright の `extend()` モデルに従うため、後の層は前の層に依存できます。
したがって、fixture は別の fixture に依存でき、その fixture は builtin に依存できます。

fixture は builtin を上書きできます。
たとえば、`page` fixture は executor が起動するページを包めます。
(`page: async ({ page }, use) => { page.setDefaultTimeout(10_000); await
use(page); }`)。
この場合、依存の `page` は下層の builtin を指します。
上書きする fixture 自身は指さないため、この依存は循環ではありません。
`page`、`context`、`pageAs` のどれも分割代入しない上書きは、executor が引き続き所有して計測するページを返せません。
したがって、`check` は `page-override-unowned` で拒否します。

上書きは依存を足すこともできます。
`nuka init --server "<command>" --server-url <url>` は、テスト対象のプログラムを `runServer` で起動する `server` fixture と、builtin の `request` と `server` を分割代入して builtin をそのまま返す `request` の上書きを書きます。
これで `request` を分割代入するすべての step が先にサーバを起動し、feature は束ねる step を通して、実行したものを引き続きすべて名指しします。
`runServer(command, args, { url, cwd, env, timeout })` は、`runCommand` と同じ理由で、fixture ではなく `nukadoko` からの import です。
プログラムを shell なしで実行し、URL のホストとポートが TCP 接続を受け付けた時点で `{ url, stop() }` に解決します。
起動完了の判定はこの観測だけです。
ログの行や HTTP のプローブは、プログラムごとに何を出力するか、どの path が応答するかの推測になります。
プログラムを起動する前からそのポートが接続を受け付けているときは reject します。
そのままでは、すべての request が自分の起動していないサーバに届くからです。
プログラムが先に終了したときは、その終了の仕方と stderr を挙げて reject します。
timeout(既定は 10 秒)を過ぎたときは、プログラムを止めてから reject します。
プログラムにポートは伝えません。
`PORT` 変数は慣習にすぎないので、プログラムは自分の手段でその URL で待ち受けます。
`stop()` は SIGTERM を送り、5 秒後に SIGKILL を送ります。
Windows では、`runCommand` と同じやり方でプログラムを探して起動するので、拡張子のない `npm` や `.cmd` のファイルも使えます。
Windows の `stop()` は、`taskkill /t /f` でプログラムとそれが起動したすべてのプロセスを終わらせます。
Windows のシグナルは名指ししたプロセスしか終わらせないので、そのままでは `npm` が起動したサーバがポートを持ち続けるからです。
生成される fixture は既定の `scenario` scope のままです。
これはシナリオ間でサーバの状態を共有しない scope で、`{ scope: "process" }` はサーバが状態を持たないという作者の宣言です。

自分の `scratch` fixture をすでに宣言しているプロジェクトは、それをそのまま使えます。
その `config.fixtures` エントリは、他の上書きと同じく、実行時に builtin を置き換えます。
型もプロジェクトのものが優先されます。
プロジェクトは `StepFixtures` を拡張して(`declare module "nukadoko"`)自分の fixture に型を付けますが、`scratch` はそのインターフェースのメンバーではありません。
そのため、形の違う宣言もそのままコンパイルできます。
step の `run` が受け取るのは `FixtureBag` です。
これは `StepFixtures` に、プロジェクトが同じ名前で宣言していない置き換え可能な builtin(`ReplaceableFixtures`、現在は `scratch` だけ)を加えたものです。

スコープは 2 つあります。
既定の `scenario` スコープは、scenario ごと、または `nuka do` の実行ごとに fixture を再構築します。
その scenario または実行の終わりに fixture を teardown します。
`process` スコープは、`nuka run` の実行中に step が最初に名指した時点で fixture を構築します。
step は直接、または別の fixture を通じて名指せます。
nukadoko は、そのプロセス内のすべての scenario が終わったあとに fixture を teardown します。
既定の並行度 1 では、そのプロセスが invocation 全体を受け持ちます。

worker はプロセスであるため、`worker` スコープは存在しません。
`nuka run --concurrency <n>` は scenario を `n` 個の worker プロセスで実行するため、`process` はすでに 1 つの worker を指します。
`nuka do` では、1 回の実行に両方の完全な寿命が含まれます。
したがって、このコマンドでは `process` fixture は `scenario` fixture と同じように動きます。

`process` fixture が依存できるのは、別の `process` fixture と、`env`、`requireEnv`、`baseURL` の 3 つの builtin だけです。
これらの builtin の値は scenario context に依存しません。
`fixture-scope-violation` は、`page`、`context`、`pageAs`、`request`、`resultOf`、`call`、`section`、`poll`、`evidence`、`scratch`、`scenario` fixture への依存を拒否します。
`call` への依存は `process` fixture に限らず、すべての fixture で拒否されます。
`call` は step の境界を必要とするためです。
`process` fixture は、これらの値を供給する scenario より長く生きる場合があります。

`process` は 1 つのアドレス空間を指します。
1 回の `nuka run` 実行を指すものではありません。
fixture の値は素の JavaScript オブジェクトであり、別のプロセスへ渡せません。
したがって、このスコープは常に「プロセスごとに 1 回」を意味します。
`nuka run --concurrency <n>` の実行は `n` 個のプロセスを使うため、fixture を `n` 回構築します。
2 つの寿命が一致するのは、既定の並行度 1 のときだけです。
世界で正確に 1 回だけ実行する必要がある処理に `process` fixture を使わないでください。
例には、データベースのシード、マイグレーション、ポートを所有するモックサーバがあります。
プロセスを追加するたびに、その処理が再び実行されます。

step の成否にかかわらず、teardown は構築の逆順を使います。
step の失敗によって fixture の片付けが省略可能になることはありません。
`nuka run` または `nuka do` の途中で SIGINT、SIGTERM、SIGHUP のどれかを受けても、fixture の片付けは省略できません。
fixture を構築したプロセスは、scenario スコープを teardown し、context を dispose し、process スコープを teardown して、128 にシグナル番号を足したコードで終了します。
その実行は完了していないので、`use()` は `"failed"` を受け取ります。
2 回目のシグナルでは、すぐに終了します。
`nuka run --concurrency <n>` では、親プロセスが各シグナルをすべての worker に転送します。
1 回目では、各 worker が fixture を片付けて終了し、新しい worker は起動せず、親プロセスは書き込んだ分の summary を出力して 128 にシグナル番号を足した値で終了します。
2 回目では、各 worker と親プロセスがすぐに終了します。
各 worker は自分のプロセスグループで動くので、端末のグループへのシグナルは親プロセスを通してだけ届きます。
親プロセスが転送せずに終了したとき (SIGKILL や、プロセスグループごとの kill) は、各 worker がそれを 1 回目のシグナルとして扱い、fixture を片付けます。
親プロセスがシグナルを転送したあとに終了したときは、各 worker はそのシグナルで始めた片付けを最後まで続けます。
worker は IPC チャネルが閉じたことで親プロセスの終了を知ります。
worker 内のプロジェクトのコードが `process.disconnect()` を呼んでもこのチャネルは閉じるので、worker はそのことを stderr に書き、シグナルを受けたときと同じく停止します。
worker の stdin は空なので、stdin を読む step はすぐに終端を受け取ります。
Windows では、コンソール上のすべてのプロセスがすでに Ctrl-C を受け取るので、親プロセスは転送しません。
nukadoko は 1 つのプロセス内で fixture の構築と teardown を**直列に**行うため、この逆順は正しく機能します。
逆順によって、各依存はその依存先より長く生きます。
`nuka run --concurrency <n>` も、この規則を保ちます。
各 worker はプロセスであり、自分の scenario を順番どおりに実行し、他の worker の fixture を決して見ません。
したがって、ある scenario が別の scenario がまだ使っている依存を teardown することはありません。
nukadoko が scenario を 1 つのプロセス内で並行に実行するのではなく worker プロセスで実行するのは、この規則が理由の 1 つです。
1 つのプロセス内での並行実行は、fixture グラフの形ではなくタイミングによってこの規則を破り、`check` はタイミングを見ることができません。

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
これらのチェックは、`page` のような組み込みの fixture には存在しなかった状態を扱います。
fixture は、nukadoko が `use()` で中断し、teardown 中に再開するコルーチンです。
最初のチェックがないと、`use()` に到達しない fixture が run を永遠に止める場合があります。

setup と teardown は、それぞれ別のタイムアウト予算を受け取ります。
`config.fixtureTimeout` は既定の予算を 60 秒に設定します。

typed step 自身の `run` には締め切りがあります。
`nukadoko.config.ts` の `stepTimeout` がプロジェクトの既定を決め、既定値は 20 分です。
`defineStep({ timeout })` は 1 つの step についてそれを上書きします。
これがあることで、返らない step は `error.kind: "timeout"` の失敗した step になり、run は次の scenario へ進んで summary に到達します。
「制限なし」を意味する値はありません。
返らない step は run 全体を道連れにし、終わらない run は何も報告しないからです。
それを止めるためにあります。
`nuka steps` と `nuka describe` は、step が自分の `timeout` を宣言していればそれを示します。

`defineStep` は、有限でない、0 以下、または 2147483647 より大きい `timeout` を拒否します。
Node のタイマーは、その範囲の外にある遅延を 1ms に切り詰めるため、書いた締め切りとは別の事実として step がタイムアウトしたことになってしまうからです。
同じ呼び出しは、この節が述べる形になっていない定義も拒否します。
`args` と `returns` は zod のスキーマ、`run` は関数、`pattern` は文字列、`patterns` は文字列の配列、`parts` の各要素は step でなければなりません。
`.js` の step ファイルは型チェックされません。
例外は discovery がファイルを import するときに投げられ、`nuka check` はそれを `step-file-import-failed` として報告します。

以前のリリースが読んでいた `rationale` のように、これらのどのオプションでもないキーは拒否されません。
実行時には何も変えないからです。
`defineStep` はそのキーの名前を残し、`nuka check` は step ファイルを添えて `step-option-ignored` を警告します。
`tsc` も同じキーを余分なプロパティとして報告しますが、それは `tsconfig.json` が step ファイルを含むプロジェクトだけです。

既定値は「step はこれくらいで終わるはずだ」という見積もりではありません。
返ってこない step を止まったとみなす地平です。
実際の step の所要時間からは遠く離れています。
実物のブラウザのスイートから 800 件の step record を無作為抽出したところ、中央値 66 ms、最大 14 秒で、30 秒を超えたものはありませんでした。

compat step は意図して対象外です。
glue 自身が 0 以上の `{ timeout }` を宣言するか、`setDefaultTimeout` を 0 以上の値で呼ばない限り、無制限で走ります。
負の値は無制限を意味し、cucumber-js と同じです。
cucumber-js は数値が 0 以上のときだけタイマーを仕掛けます。
`setDefaultTimeout(-1)` と、step や hook の `{ timeout: -1 }` は、制限を切るための書き方です。
0 は制限時間として効きます。
cucumber-js 自身の 5 秒の既定を持ち込むと、切り替えただけで既存のスイートの遅い step が落ち始めるからです(「Compat steps」を参照)。
typed step は移行してくる資産ではないので、その理由は届きません。

fixture は `options.timeout` で上書きできます。
タイムアウトの報告は fixture と局面の両方を名指します。

setup のタイムアウトは、scenario を失敗させます。
fixture 関数はそのあとにも走り続けます。
そのあとで `use()` を呼ぶと、呼び出しは `"failed"` で解決し、`use()` のあとに書いた teardown は teardown の予算のもとで走ります。
その遅い teardown は、`use()` に到達したときに走ります。
タイムアウトした setup はインスタンスを作っていないので、逆順の teardown に含める対象がありません。
その遅い teardown の失敗は stderr に書きます。
scenario record はすでに閉じている場合があり、stderr がその失敗を届ける報告です。
きれいに終わった teardown は何も書きません。

`check` は fixture を実行せずに、fixture に関する 4 つの所見を報告します。
`fixture-cycle` は、`config.fixtures` エントリ間の依存循環を特定します。
`fixture-scope-violation` は、`scenario` fixture に依存する `process` fixture を特定します。
`page-override-unowned` は、上で説明した無効な `page` の上書きを特定します。
`fixture-structural-violation` は、分割代入を読めない `config.fixtures` の関数、nukadoko が知らない fixture を名指す関数、または `call` を名指す関数を特定します。
所見はその fixture を名指し、fixture についての文言で述べます。
既定値の変換後のソースは引用しません。

`nuka check` は 1 つの事実を注記として追加で報告します。
`fixture-unused` は、直接にも別の fixture 経由でも、どの typed step も要求しない `config.fixtures` エントリを特定します。
そのエントリには `nuka do` から引き続き到達できます。
`--json` では、この所見は fixture の名前を `fixture` フィールドに入れ、`step` は設定しません。
同じ名前の fixture と step を区別するためです。
この注記は fixture を特定するだけであり、その fixture がそこに属するかは読み手が判断します。

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
import createProject from "./create-project.ts";

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
`nuka steps --json` と `nuka describe` は、どちらもそれを `{ "projectId": { "step": "create-project", "key": "id" } }` として示します。
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
先行する行がどの step にも一致しない場合、その判定は条件付きになります。
その行は、タイプミスを含んだ生産者かもしれないからです。
そのとき `nuka check` は、そうした所見をその行の `undefined-step` の所見の後ろに保留します。
scenario ごとに 1 つの `from-order-check-suppressed` 警告が、保留したすべての消費側、キー、生産者を挙げます。
その行が step に一致した後もまだ当てはまる所見は、次のチェックで報告されます。
`nuka run --no-check` も同じ所見を保留するため、scenario はその未定義の行そのもので失敗し、その後の step はスキップされます。
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
ソフトウェアの目的を決める人たちはその feature に合意しており、レビュアーがすでに承認しているかもしれません。
実装のリファクタは、合意済みの文を維持する必要があります。

代わりに、step は別の step を呼び出せます。
`parts` は呼び出す step を宣言し、`call` fixture がその 1 つを実行します。

```ts
import { defineStep, z } from "nukadoko";
import createProject from "./parts/create-project.ts";
import inviteMember from "./parts/invite-member.ts";

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

step は複数の呼び出しを同時に開始できます。
たとえば `await Promise.all([call(a, {}), call(b, {})])` です。
各呼び出しは、それを行った step の `parts` に対してチェックされます。
そのため、別の part と並んで走る part が、その part の呼び出し元と誤解されることはありません。
1 つの step が同時に行った呼び出しは、その step の下に兄弟として現れます。
順序は終了順ではなく、開始順です。
part が開始した呼び出しは、その part の下に入れ子になります。

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
`nuka check` はその場合を注記として報告します。
利用できる静的データからは、part が使われていないかを判定できません。

矛盾チェックは、読み取り専用ポリシーを強制しません。
読み取り専用 environment では、`call` が `mutates: true` の part を実行前に拒否します。
呼び出し元の宣言は、この拒否を変えません。
静的チェックは、より早く低いコストで矛盾を見つけます。
静的チェックが実行されなかった場合は、実行時の拒否が実行を保護します。
どちらの制御も、part の宣言を信頼します。

「step の連鎖」の軸を広げて、ヘルパー、part、step から選びます。
操作が scenario の読み手にとって意味を持つ場合は、step にします。
scenario record は、その step record を引用します。
それ以外の場合は、失敗の record が示すべき内容を検討します。
操作に有用な契約、入力、result がある場合は、part を使います。
いずれもない場合は、`features/steps/lib/` の下にある通常の関数を使います。
ヘルパーには、独立した record エントリがありません。
その HTTP 呼び出しは呼び出し元の step の http.jsonl に引き続き載り、`section` は実行の進行を示せます。
コマンドラインのプログラムを実行するヘルパーは `runCommand` を使います(「Records」を参照してください)。
そうすると、ヘルパーが起動した各プロセスは、呼び出し元の step の `observed.processes` に並びます。
たとえば、payload を整形する関数や fixture ファイルを選ぶ関数には、通常、保存する価値がある契約や result がありません。
この関数を part にすると、維持する schema だけが増えます。

1 つの代替案を却下しました。
step ファイルは、named export を使って複数の step を export できます。
この設計では、分割した操作を複合 step の隣に置けます。
しかし、型付き step の名前は、そのファイルの basename です。
CLI は、named export があるファイルを import しなければ、その export を認識できません。
part ごとにファイルを分けると、step の名前とファイル名が一致したままになり、ファイルが 1 つ増えます。

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
- **実行時には**、step record が実行内容を、ツールが正確に計測できる範囲で保存します(「Records」を参照)。
  書き込みについての断定は保存しません。
  保存したものは、Then の位置も、読み取り専用 environment のポリシーも決めません。
  nukadoko は、step record が何を持っていても `mutates: false` を信頼します。
- Gherkin は、`And` または `But` の step を、直前の主要キーワード(Given、When、Then)の pickle step type で分類します。
  Gherkin の pickle コンパイラが、この挙動を定義します。
  したがって、`Then` のあとの操作は、その位置にある他の step と同じ Then 位置の観測を受けます。
  その位置は、操作をゲートしません。
- 計測では、この事実を決められません。
  HTTP メソッドは、書き込みの意味論そのものではなく、そのプロキシです。
  GraphQL、RPC-over-POST、多くのベンダー query API は、意味的に純粋な読み取りに POST を使い、サーバは GET で状態を変えることもあります。
  呼び出しがサーバの状態を変えるかは、外部システムが定義します。
  nukadoko が観測するのは、その下にある HTTP レイヤーだけです。
  各プロトコルは、読み取りと書き込みを区別するために異なるデータを使います。
  たとえば、GraphQL body の `query` または `mutation`、RPC のメソッド名、ベンダーの path 規約です。
  汎用の機械的な規則では、この区別を判断できません。
  そのため規則は、正確に計測できるものを計測し、計測できないものはそうと印を付け、メソッドから書き込みを推測しない、です。
  step record は、step が送ったものと受け取ったものを残します。
  サーバの状態が変わったかどうかは述べません。
- 読み手は実行後に step record を使って誤った宣言を反証できます。
  この境界は、mutation の意味論に対するツールの権限が終わる場所を示します。
- nukadoko は、この比較を実行しません。
  `nuka run`、`nuka check`、run サマリは、計測と宣言が矛盾すると主張しません。
  その主張は、HTTP メソッドのプロキシを確定した事実として扱います。
  GraphQL の読み取り、RPC-over-POST の読み取り、ベンダー API の POST による読み取りを、すべて偽陽性として報告します。
  同じ理由で、nukadoko は実行時に mutation の意味論を強制しません。
  pull request をレビューする人が、宣言と step record を並べて読みます。
- Compat(型のない)step には、`mutates` の宣言がありません(「Compat steps(移行の扉)」を参照)。
  `nuka check` の `then-compat-step` 警告は、compat step が Then の位置に結び付けられたときに、このカバレッジの欠落を示します。
  mutation の矛盾は示しません。
  実行時の観測は他の step と同じ計測を記録しますが、それは何もゲートしません。

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
  代入した request context を通して step が送ったリクエストは、それでも http.jsonl の `node:http` または `node:https` の行になります(「Records」を参照)。
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
  この enum の他のメンバー(`PENDING`/`SKIPPED`/`UNDEFINED`/`AMBIGUOUS`)は決して一致しません。
  nukadoko には、hook 自身の result が運びうる pending、skipped、undefined-step、ambiguous-match のいずれの概念もないからです。
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
  残りが何を必要とするかは [docs/migration.ja.md](migration.ja.md) に列挙されています。
  監査から 1 つの規則を定めました。
  compat がサポートしない挙動は、import 時または最初の run で失敗する必要があります。
  移行するチームは、大きな声の失敗には対処できますが、静かな失敗は見えません。
  だから、黙って振る舞いを変えてしまう抜けは、機能が欠けていることが食ってきた時間よりも多くの信頼を食います。
  import の失敗と下の所見は、この規則を満たします。
  値の水準の違いはまだいくつか残っています。
  それらは失敗しないので、計測済みのものを 1 つずつ [docs/migration.ja.md](migration.ja.md) の「既知の限界」に挙げています。
- 明示的な失敗は、静的な所見と step の実行が必要な失敗に分かれます。
  `nuka check` は、静的な所見だけを報告します。
  **`nuka check` が報告できる失敗**: import が例外を投げる step ファイルは `step-file-import-failed` エラーになります。
  原因には、`nukadoko/compat` が export しない名前の値としての使用、ESM glue 内の CommonJS `require`、深い subpath の import があります。
  単一の `@tag` / `not @tag` を超える hook のタグ式は、`unsupported-hook-tag-expression` エラーになります。
  どちらも、何かが実行される前に、そのファイルのテキストだけから分かります。
  その隣にはさらに 2 つの所見があり、どちらも 1 つのファイルの中身についてではなく discovery 自身が歩く範囲についてのものです。
  `.cjs` または `.cts` のファイルが `featuresDir` の下にあるときの `step-file-unsupported-extension`(nukadoko がそれを import しない理由は前述の「型付き step」を参照)と、歩いた結果として試せるものが何もなかったときの `no-step-files-found` です。
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

この移行によって、nukadoko の 2 つの経路が開きます。
`nuka run` は feature ファイルに経路を固定し、`nuka do` は各 step を単体で実行します。
既存のスイートがすでに信頼する操作は、agent が探索に使う語彙になります(「単体 step」を参照)。

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
nuka run [<feature[:line]|dir>...] [--no-check] [--env <name>]... [--concurrency <n>] [--repeat <n>] [--since <git ref>] [--records] [--json]
```

`@cucumber/gherkin` は、ファイルをフラットで自己完結した pickle にコンパイルします。
コンパイラは Background をマージし、Scenario Outline を展開して、table を結び付けます。
nukadoko は各 pickle の step をコミットされた pattern と照合してから、step を順番に実行します。
始まった各 step に 1 つの step record を書き込み、run が終わるとすべての scenario を持つ 1 つの `run.json` を書き込みます。
`run.json` は、各 scenario の feature のパス、行、名前と、各 step の行、テキスト、status、step record を持ちます。

`nuka run` は何かを実行する前に、選んだ scenario について `nuka check` が報告するはずの内容を報告します。
その中に error が 1 つでもあれば、error を stderr に書き、record を書かずに `1` で終了します。
報告されるのは、同じ対象について `nuka check` が出すものです。
すなわち、プロジェクト全体に関わる指摘(config、binding、各 step 自身の宣言、fixture の定義、import に失敗する step ファイル)と、この run が実行する scenario についての指摘です。
`:line` の対象が絞るのは scenario についての指摘だけなので、1 つの scenario の run が、実行しない隣の scenario のせいで拒否されることはありません。
警告は run を止めず、出力もされません。
`--no-check` はこの check を飛ばし、`check` が拒否する scenario を意図して実行するときに使います。
その場合も、以下で述べる実行時の拒否は変わらず働きます。
数秒で終わらなければならないゲートと `additionalFeatureDirs` のためには、`nuka check` が別のコマンドとして残ります。

`nuka run` は 0 個以上の対象を受け取ります。
対象が無ければ `featuresDir` を実行します。
これは `nuka check` が既定で辿るディレクトリです(`additionalFeatureDirs` は含みません。
それを読むのは `nuka check` だけです)。
各対象には feature ファイル、`ファイル:行`、ディレクトリのいずれかを指定できます。
`.md` で終わるパスは名指しで拒否されます。
nukadoko は scenario を `.feature` ファイルからだけ読むからです。
ディレクトリは再帰的に走査され、その下の `.feature` ファイルが選ばれます。
どの深さでも、走査は `node_modules` と `.` で始まるディレクトリ(`.git`、`.nukadoko`、`.vscode` など)をスキップします。
これは step discovery がスキップするディレクトリと同じです。
このスキップは何も報告しません。
それらのディレクトリの中の `.feature` ファイルは、チェックされず、実行もされません。
選ばれたファイルは重複を除いた 1 つの集合になり、ファイル全体の指定は、そのファイルに対する行指定を含みます。
ファイルは実パスで区別します。
そのため、リンクしたディレクトリとそのリンク先のように、2 つの対象が別の経路で同じファイルに届くときは、そのファイルを一度だけ、最初に届いた経路の名前で選びます。
選ばれたすべての pickle は 1 つの invocation に属します: 1 つの run_id、1 つのサマリ、1 つの exit code、1 つの messages ストリーム、1 つの Allure results ツリーです。
ファイルはリポジトリ相対パスをロケールではなくバイトごとに比較した、決まった順序で処理されます。
そのため、どの scenario が何番目に実行されたかは run をまたいで安定し、ある record やレポートを別の run のものと比較できます。
後述の `--concurrency` は、この走査順序を保ちつつ位置は手放します。
ファイルは同じ順序で配られますが、record は worker が終えた順に並びます。
ディレクトリに `:line` を付けると拒否されます。
`:line` は 1 つのファイルの中から 1 つの scenario を選ぶものであり、ディレクトリはその中から選ぶべき単一のファイルを名指ししていないからです。
走査が見つけられる `.feature` ファイルを持たないディレクトリも拒否され、`nuka check` 自身の `no-step-files-found` と同じ語り口で、実際に何を歩いたかを名指しします。
何もしなかった run は、exit 0 で何もしなかったことにするのではなく、それを大声で言わなければならないからです。

`--concurrency <n>` は、複数の feature ファイルを同時に実行します。
既定値は 1 で、1 のときはこの節の他のすべての段落が説明するとおりに動きます。

nukadoko は、作業を worker プロセスに分散します。
親プロセスが pickle を選び、feature ファイルをまるごと各 worker に渡し、各 worker は `--concurrency 1` の run と同じ直列エンジンで、渡されたファイルを実行します。
親プロセスは、run の identity を最後まで保ちます: 1 つの run_id、1 つの stdout ストリーム、1 つの messages ストリーム、1 つの Allure results ツリー、1 つのサマリ、1 つの exit code です。
そのため `run.json` の scenario のエントリは、worker が作ったものでも直列の run が作ったものでも同じように読めます。
run サマリも、feature のすべての行をカバーする 1 つの run として記述します。

この spec が worker プロセスを名指すのは、その選択がこのフラグの約束の中身を決めるからです。
あとでスレッドや promise に差し替えれば、その約束も変わります。
scenario は、ブラウザの中、HTTP 呼び出しの中、またはプロジェクト自身の JavaScript の中で時間を使い、この 3 つのうち最後の 1 つだけが 1 つのイベントループを塞ぎます。
1 つのプロセス内での並行実行は、前の 2 つには届きますが、3 つ目は元と同じだけ遅いまま残し、nukadoko は渡されたスイートがこの 3 つのうちどれでできているかを計測できません。
あるスイートは速くなるのに、別のスイートは何も変わらないフラグは、ツールが守れない約束です。
分かれたプロセスは、この 3 つすべてに届きます。

配る単位は feature ファイルです。
1 つのファイルの中のすべての scenario は、1 つの worker の中でファイル順に実行されるため、Background とその後の scenario は、並行度 1 のときと同じ関係を保ちます。
ファイルは歩いたときと同じ決まったバイト順で配られるため、どの worker がどのファイルを受け取るかは run をまたいで揺れません。
したがって、1 つのファイルを名指した run では `--concurrency` が 1 を超えてもすることが何もなく、`nuka run` は、何もすることのない worker を起動する代わりにそう伝えます。

`Feature:` 行に付けた `@nukadoko:serial` タグは、そのファイルを他のどのファイルも実行していない間に実行します。
これは、nukadoko には見えない何かをファイル同士が共有しているスイートのための宣言です: 1 つのテストアカウント、1 つの行、1 つのキューです。
fixture の scope は、この問いに決して答えられません。
scope が届くのは nukadoko 自身が構築するものだけであり、答えが属するのは feature ファイルの側、すでに名指している他のすべての隣だからです。
タグが読まれるのは `Feature:` 行の上だけです。
`Scenario:` の上では何もしません。
1 つのファイルの中の scenario はすでに 1 つの worker の中で実行されるため、`nuka check` はそれを有効な規則であるかのように読ませる代わりに `serial-tag-on-scenario` として報告します。
Gherkin のタグは自由記述なので、名前空間は、短いタグ名をスイートがすでに使っている意味との衝突から守ります。

`--repeat <n>` は、選ばれたすべての scenario をこの 1 回の呼び出しの中で `n` 回実行します。
選択全体を 1 回、それからもう 1 回、という順です。
前に走ったものに依存する失敗が、毎回同じ隣人と出会うためです。
各実行は `run.json` の `scenarios` でそれぞれ自分のエントリになり、`verdicts` のセルが実行の回数と通った回数を数えます。
1 回でも失敗した scenario は、failed の一覧の後に `repeat` の行を 1 つ得ます。
`<passed> of <n> passed` の形で、判定は付けません。
毎回失敗する scenario は flaky ではなく、読み手に要るのは回数だからです。
このフラグは、数回に 1 回だけ再現する失敗のためにあります。
これが無いときの答えはシェルで `nuka run` を回すループで、それは証拠をその回数ぶんの run id に散らします。
run サマリが読むのは 1 つの run です。
messages ストリームでは、各実行は 1 つの retry ではなく、それぞれ自分の `testCase` になります。
test case を列挙する formatter は、すべての実行を列挙します。
Allure では、1 つの environment の中の各実行が scenario 自身の identity を持つため、レポートは 1 つのテストとして表示し、他の実行をその retry として並べます。
ときどき失敗する scenario が最も読みやすいのはそこです。
run サマリのセルは `<passed> of <n> passed` と読めます。
3 回 green は 1 回 green とは別の主張であり、レビュアーはその回数を目にします。
`repeated-scenario-prefix` の note は、何回走ったかによらず scenario を 1 回と数えます。
`--concurrency` の下では、各 worker が自分のファイルを繰り返すので、配る単位はファイルのままです。
1 つのファイルを名指す target は変わらず 1 で走ります。
1 つの scenario を複数の worker で同時に走らせることは、このフラグの仕事ではありません。

どの run も、最後にもう 1 つ計測をします。
同じ step で始まる scenario と、その繰り返しにかかったコストです(`repeated-scenario-prefix`、note)。
同じ始まりを共有することはよくあります。
1 つのページについて扱う複数の scenario が、どれもそのページへ移動するところから始まるのは自然です。
その始まりに時間がかかるのに何も切り出されていない場合は腐敗となり、scenario が増えるたびにコストも増えます。
この note は feature ファイルから読むのではなく、計測して得られます。
`run.json` を書く前に、run は自分の scenario を先頭の step でグループ化し、各 step の record から所要時間を読み、そのグループ、step、合計時間を名指しします。
始まりは最初の When または Then の手前で終わり、2 つの step が同じ step とみなされるのは docstring や table も同じときだけです。
同じ始まりを持つ一群ごとに note を 1 件だけ出すため、入れ子になった 1 つのグループが 3 つの深さで重複して数えられることはありません。
どの深さを名指すかは所要時間に左右されません。
共有する step の実行回数(scenario の数と共有する step の数の積)が最も多い始まりを選び、同じなら長いほうを、それも同じなら feature ファイルで先に出てくるほうを選びます。
所要時間で順位を付けていたときは、速いスイートでは run ごとに違う始まりを名指していました。
そこでの差は誤差でした。
note を出す条件は 2 つあり、scenario が 2 つ以上あることと、その run の scenario の合計時間の 2% 以上を占めることです。
この下限は実際のスイートを 1 つ計測して決めました。
そのスイートでは、コストを丸めるとゼロになるグループだけが除かれ、名指せる 101.5 秒のうち失ったのは 0.2 秒でした。
分母に scenario の合計時間を使うため、どの `--concurrency` でも同じ結果になります。
その run で 2 回以上走った scenario(`--repeat`、または 2 つ以上の `--env`)は、最後の実行として 1 回だけ数えます。
この note が報告するのは数値までです。
同じ始まりに対する処置は、その step が後の scenario の読む状態へ書き込むかどうかに左右されます。
step record には、各 step 自身の `mutates` の宣言が載っています。
共有する step がすべて `mutates: false` を宣言しているときは、切り出し先として `process` スコープの fixture を名指します(「Fixtures」を参照)。
そうでない step があるとき(`mutates: true` を宣言している、宣言を持たない compat step である、または step record が無い)は、その step を名指し、`process` スコープの fixture ではその step が書き込むものを scenario の間で共有してしまうと伝えます。
計測した HTTP API のプロジェクトでは、書き込む始まりにこの助言を当てはめると、7 つの scenario のうち 2 つが失敗しました。
節約できる時間を示すことは、切り出しが可能だと主張することになりますが、ここでの計測はその可能性を裏付けません。
scenario の status も終了コードも変えません。

`--since <git ref>` は、人が承認した基点(pull request の向かう先のブランチなど)から、受け入れ基準の何が動いたかを、以下の比較が届く範囲で述べます。
何かを実行する前に、run が対象にした feature ファイルを、ref が名指すコミットと比べます。
対象がディレクトリなら、コミットがその下に持つすべての `.feature` ファイルも比べるので、ref の後で消したファイルの受け入れ基準は removed になります。
対象がファイルなら、そのファイルだけを比べ、`since.compared` が対象を名指します。
scenario の受け入れ基準は、その scenario がどう走るかを決めるもので、ファイルではなくコンパイルした scenario から読みます。
それは、scenario が持つすべての tag(Feature、Rule、Scenario、Examples の tag で、hook、直列の実行、選択を決めます)、その feature と Rule のすべての Background の step、scenario 自身の step です。
step は、実効の keyword(`And` と `But` は続けている keyword を取ります)、本文、docstring の中身と media type、data table のセルで比べ、Scenario Outline の行については Examples の見出しとその行も比べます。
インデント、空行、コメント、docstring の区切り、他の scenario の順番は、変わっても変更とは数えません。
比べるのはこの構造なので、`|` を含む表のセルが 2 つのセルと取り違えられることはありません。
ref の側の scenario は、Rule と名前で見つけます。
Examples の行は、見出しと値で見つけます。
名前が ref か今のどちらかで重なるときは、その名前の scenario をまず中身で対応づけます。
その中の 1 つだけを書き換えたなら、それは `changed` です。
中身で 1 対 1 に対応づけられないときは、対応しない各 scenario を位置で対応づけず、`reason` を添えて `ambiguous` にします。
各 scenario の `run.json` のエントリは `criteria.changed_since` を持ちます。
値は `unchanged`、`changed`、`new`(名前を変えた scenario、値が変わった行、ref にないファイル)、`ambiguous`、`unknown`(ref でファイルが parse できないもので、`reason` を持ちます)のどれかです。
unchanged ではない scenario は現在の `lines` を持ち、どの scenario も `step_files` を持ちます。
`step_files` は、その行が束ねた step を登録するファイル、その step が宣言する part のファイル、そしてその step が config の定義する fixture を必要とするときの config ファイルです。
それらのファイルが import するものは比べません。
`since` は、ref、そのコミット、比べた対象の `compared`、消えた受け入れ基準の `removed`(各々の feature、Rule、scenario、ref での `lines`)、各 step ファイルの `change` を名指し、最初の scenario が走る前に読みます。
`change` は、`git diff` がファイルをコミットと比べた結果の `unchanged` か `changed` で(そのため改行コードとフィルタが効きます)、コミットがそのファイルを持たなければ `untracked` です。
サマリの「Criteria since」の節は、それぞれの数を数え、何を比べたかを述べ、unchanged ではない各 scenario と消えた各受け入れ基準を引用し、変わった各 step ファイルの下に、それを名指すすべての scenario を unchanged のものも含めて並べます。
そのため変更を承認する人はその行を読み、変わらなかった行の下でどの step ファイルが動いたかを見られます。
これは報告するだけです。
変更を失敗に変えるフラグはなく、終了コードは run のものです。
コミットを名指さない ref は `since-ref-unknown` で、git の外のプロジェクトは `since-outside-git` で、それ以外の git の失敗(git がない、またはコミットがファイルを持たないこと以外の理由で失敗したコマンド)は `since-git-failed` で、何かを実行する前に拒否されます。
フラグがないとき、すべての scenario は `criteria: { changed_since: null }` を持ち、`since` は `null` です。

`--env` は繰り返せます。
`nuka run --env a --env b` は、1 つの `run_id`、1 つの `run.json`、1 つのサマリ、1 つの終了コードを持つ 1 回の run で、選ばれたすべての scenario を各 environment で 1 回ずつ実行します。
`--env` は、config が定義していてもいなくても `default` という名前を受け付けます。
それは `--env` なしの run が使う environment(トップレベルの設定、または config が定義していれば `environments.default`)で、`run.json` がそう名付けるものなので、`--env default --env staging` は両方を実行します。
environment は与えた順に 1 つずつ走ります。
`a` で選択全体を実行し、それから `b` で選択全体を実行するので、2 つの environment が同時に同じ対象を共有することはありません。
各回は、それだけを走らせたときと同じ run です。
自分の env file、secret、version の probe、`baseURL`、policy、自分の BeforeAll と AfterAll、自分の `"process"` スコープの fixture を持ち、その fixture は次の environment が始まる前に teardown されます。
environment は汎用の設定のままです。
nukadoko は feature flag という概念を持たず、2 つの environment の違いは、それぞれの env file と `baseURL` が言うことだけです。
各 scenario のエントリは自分の `environment` を持ちます。
`verdicts` は scenario と environment の組ごとに 1 つのセルを持ち、その中のどれか 1 つの実行が失敗ならセルも失敗です。
どれか 1 つのセルが失敗なら終了コードも失敗です。
同じ environment を 2 回名指すと、何も走る前に拒否されます。
そのセルを互いに区別できないからです。
他のフラグとは次のように組み合わさります。
`--repeat <n>` は各 environment の中で繰り返すので、1 つのセルは `n` 回の実行を持ちます。
`:line` の対象は scenario を選び、選ばれた各 scenario がすべての environment で走ります。
`--concurrency` の下では、各 environment は、それぞれ独立した 1 回の実行です。
並列の段階と `@nukadoko:serial` のファイルを終えてから、次の environment の worker が始まります。
シグナルは、次の environment が始まる前に run を止めます。
retention は run を数え、2 つの environment にまたがる run も 1 つの run ディレクトリです。
`repeated-scenario-prefix` の note は、scenario がいくつの environment で走っても 1 回と数えます。
messages ストリームでは、`--repeat` のときと同じく各実行がそれぞれ自分の `testCase` になります。
Allure では environment が result の identity の一部なので、ある environment で通り別の environment で失敗した scenario は、retry ではなく 2 つのテストになります。
environment が 2 つ以上あるとき、所見と `repeat` の行は scenario の後に environment を名指し、進捗のログは各回を `environment <name>` の行で始めます。

worker はプロセスであるため、`"process"` スコープの fixture は worker ごとに 1 回構築され、compat の `BeforeAll`/`AfterAll` も worker ごとに 1 回実行されます。
「Fixtures」節はすでに `process` スコープを、1 つのアドレス空間ごとに 1 回と定義しています。
このフラグは、その定義が姿を見せる場所です。
データベースのシードやポートを所有するモックサーバのように、世界で正確に 1 回だけ起こる必要がある処理は、どの並行度でもこの 2 つの場所のどちらにも属しません。

1 を超えると、意図して変わることが 2 つあります。
親プロセスは worker が報告した瞬間に各 record を書くため、stdout はファイル順ではなく完了順に並びます。
stderr の step ごとの進捗行は、その scenario 自身が終わるまで保持され、そのあとまとめて書き出されます。
複数の scenario の行が入り交じっていては誰も読めないからです。
どちらも record の中身は変えません。

どの scenario もブラウザの状態を持たずに始まるので、scenario が 1 つ前の残したものに依存することはなく、並行度がいくつでも同じ答えになります。
ログイン状態が必要な scenario は、その feature が名指す fixture か Given step から得ます。

`--concurrency` はフラグであり、config のキーには決してなりません。
1 台のマシンが同時に実行できる scenario の数はそのマシンについての事実であり、コミットされた config ファイルはそれを保つ場所として適していません。

各 run は、2 種類の読み手に 2 つの出力チャネルを使います。
stdout はスクリプトのためのもので、求められたものだけを出力します。
`--records` のときは、scenario が終わるたびに、1 行 1 件の scenario を NDJSON として出力します。
各行は、その scenario の `run.json` のエントリです。
`--json` のときは、下で述べる `run.json` の文書を出力します。
どちらのフラグもなければ、端末かどうかにかかわらず stdout には何も出力しません。
`run.json` はフラグにかかわらずディスクにあり、`run` の行がそれを示します。
人もエージェントも stderr を読みます。
エージェントのシェルは端末ではなく、stdout を stderr と一緒に読みます。
そのため、既定で scenario ごとの JSON の行を出すと、進捗の行が埋もれます。
`--concurrency` でも同じ規則です。
プロジェクトのコードが `console.log` や `process.stdout.write` で書いたテキストは、stderr に渡されます。
これは step、Before と After の hook、BeforeAll と AfterAll、fixture の setup と teardown、World のコンストラクタ、読み込み中の step ファイル、timeout の後も動き続ける step に当てはまります。
プロジェクトのコードが `stdio: "inherit"` で起動した子プロセスは file descriptor 1 に直接書くので、その出力は stdout に残ります。
`nuka do` でも同じであり、その stdout は 1 件の step record です。
`--concurrency` の worker プロセスでも同じです。
worker の stdout は、親プロセスが読む envelope の列です。
run を見守る人向けの出力は stderr に置きます: 各 pickle の前の境界、各 step の後の 1 行、run が書いたパス、1 行のサマリです。
step の行は、その成否を step record と同じ語で示します: `passed`、`failed`、`skipped` のいずれかです。
失敗した step の行の後には、字下げした 2 行が続きます。
1 行目はエラーメッセージの最初の行で、端末の色コードを除いたものです。
2 行目はその step record のパス(`<stateDir>/runs/<run_id>/steps/<id>`)です。
メッセージが Playwright の `expect(...)` の行を含むときは、何を比べたかを示すその行の後の行が 1 行目に続きます。
`expect(...)` の行は 1 行目のこともあり、`expect(value, message)` に渡したメッセージの後の行のこともあります。
`Locator:`、`Expected:`、`Received:`、そして `element(s) not found` のような `Error:` で、最大 4 行、各行は 200 文字で切られ、`Call log:` からは取りません。
matcher の名前だけでは、ページが間違っているのか期待が間違っているのかを区別できず、2 つの値ならそれができます。
始まらなかった step には step record がないため、エラーの行だけが付きます。
この 2 行の間には、`result` が 0 以外で終わったプロセスである `used` のエントリごとに、もう 1 行が入ります。
そのような `result` とは、0 以外の数値の `exitCode` と文字列の `stderr` を持つオブジェクトで、`runCommand` が返す形です。
その行は `used    <step>  exit <code>  <stderr の最初の行>` です。
`--json` で拒否を出すプログラムのように stderr が空のときは、代わりに `stdout: ` と stdout の目に見える最初の行を載せます。
JSON の stdout は 1 行に詰めて 200 文字で切ります。
整形された JSON の最初の行は `{` だけだからです。
どちらにも目に見える文字が無いときは `(no output)` です。
並びは `used` の順です。
エラーの行とこの行は、Node が uncaught error の前に書くヘッダ(投げられた場所、そのソースの行、キャレットの行)を飛ばし、その後の目に見える最初の行を取ります。
たとえば `Error: Cannot find module '../dist/cli.js'` です。
そのため、クラッシュした Node のプログラムはそのエラーで示されます。
場所の前にある文字列と `: ` は残ります。
それ以外の文字列では、その最初の行を取ります。
`init exited 1:` のようにコロンで終わる最初の行は後に続くものの前置きにすぎないので、次の目に見える行と一度だけつなぎます(`init exited 1: Error: ...`)。
つなぐ行でも同じヘッダを飛ばします。
この行は、Then step が空の stdout を読んだ理由を示します。
実行したプログラムが起動しなかったか失敗したのに、それを実行した step は passed のままです。
exit code は結果であって、失敗ではないからです。
文字列は step record から取るので、そこに含まれる secret はすでに redact されています。
サマリ行の後では、失敗した各 scenario を所見 `failed\tscenario-failed\t<feature>:<line>\t<name>: <エラーの 1 行目>` として stderr に表示します。
その各所見に `  do:` 行が続きます。
`do:` 行は `nuka run <feature>:<line>` で、run に `--env` が与えられていれば、その scenario が走った environment を名指す `--env <name>` も付きます。
単語が必要とする場合は、POSIX シェル向けに引用符で囲みます。
この行は直列実行と並行実行の両方で表示されます。
`--json` のとき、stderr は空です。
この段落とその前の 2 つの段落が挙げる行がどれも出ず、retention の行も出ません。
stdout の文書が結果を持っていて、エージェントのシェルは 2 つのストリームを 1 つとして読むからです。
何かがうまくいかなかったことを知らせる警告(書けなかったファイル、失敗した hook や fixture の teardown、拒否の前の `nuka check` のエラー)は、code を持つ所見です。
テキストでは stderr に出て、`--json` では envelope の `findings` に入ります。

機械と監査する人向けの run の結果は `runs/<run_id>/run.json` です。
run が終わったとき、最後の step record と run サマリの後に、直列実行でも並行実行でも書かれます。
これは `nuka run --json` の envelope(「envelope」を参照)なので、`schema_version` は envelope のものです。
読み手が別のファイルを開かずに run について行動するのに要るものを、すべて持っています。

```json
{
  "schema_version": 3,
  "nukadoko": "...",
  "command": "run",
  "verdict": "failed",
  "findings": [
    {
      "severity": "failed",
      "code": "scenario-failed",
      "file": "features/greet.feature",
      "line": 4,
      "message": "greets by name: text: expected \"Hi, Ada!\", got \"Hello, Ada!\"",
      "do": "nuka run features/greet.feature:4"
    }
  ],
  "run_id": "run-20260801-143022-a1b2",
  "started_at": "...",
  "finished_at": "...",
  "commit": { "sha": "<40 hex characters>", "dirty": false },
  "environments": [{ "name": "default", "target_version": null }],
  "selection": "full",
  "counts": { "scenarios": 1, "passed": 0, "failed": 1 },
  "scenarios": [
    {
      "scenario_record_id": "scn-20260801-143023-c3d4",
      "feature": "features/greet.feature",
      "line": 4,
      "scenario": "greets by name",
      "environment": "default",
      "status": "failed",
      "started_at": "...",
      "finished_at": "...",
      "steps": [
        {
          "line": 5,
          "text": "I run greet with \"Ada\"",
          "step": "run-greet",
          "status": "passed",
          "step_record_id": "step-20260801-143023-e5f6",
          "record": "steps/step-20260801-143023-e5f6",
          "mutates": false,
          "observed": {
            "processes": [{ "command": ["node", "greet.js", "Ada"], "cwd": "...", "exit_code": 0, "duration_ms": 41, "env": { "inherited": true } }],
            "http": null,
            "files": null,
            "unmeasured": []
          }
        },
        {
          "line": 6,
          "text": "the output says \"Hi, Ada!\"",
          "step": "output-says",
          "status": "failed",
          "step_record_id": "step-20260801-143023-g7h8",
          "record": "steps/step-20260801-143023-g7h8",
          "mutates": false,
          "observed": { "processes": null, "http": null, "files": null, "unmeasured": [] },
          "error": { "kind": "step_error", "message": "text: expected \"Hi, Ada!\", got \"Hello, Ada!\"" },
          "used": [
            {
              "step": "run-greet",
              "record": "steps/step-20260801-143023-e5f6",
              "result": { "exitCode": 0, "stdout": "Hello, Ada!\n", "stderr": "" }
            }
          ]
        }
      ],
      "hooks": [],
      "do": "nuka run features/greet.feature:4"
    }
  ],
  "verdicts": [
    {
      "feature": "features/greet.feature",
      "line": 4,
      "scenario": "greets by name",
      "environment": "default",
      "verdict": "failed",
      "executions": 1,
      "passed": 0
    }
  ]
}
```

- `commit` は、run の開始時に `HEAD` が指していたコミットです。
  `dirty` は、そのとき作業ツリーに `git status --porcelain` が報告する変更(未追跡ファイルを含む)があったかどうかです。
  git リポジトリの外や最初のコミットの前では `null` です。
  `environments` は run が対象にした各 environment を `--env` が与えた順に並べます(`--env` が無ければ `default`)。
  各要素の `target_version` は、その environment のバージョン probe が答えた値です(probe がなければ `null`)。
  各要素の `base_url` は、その environment が解決した `baseURL` です(なければ `null`)。
  これで run は、コミットだけでなく、判定した相手のインスタンスも名指しします。
  `base_url` は `target_version` と同じく redact され、summary の environment の行にも出ます。
- `run_dir` は run ディレクトリを、プロジェクトのルートからの相対パスで `/` 区切りで示します。
  スクリプトは state ディレクトリの構成を知らずに、これを `nuka report` に渡せます。
  run.json の中のパスは、これまでどおりこのディレクトリからの相対パスです。
- `selection` は、`:line` の対象がそのファイルの scenario を 1 つでも外したとき `partial` で、それ以外は `full` です。
  部分実行はデバッグの結果であり、レビュアーが feature が通ったと読むべきものではありません(「レビュー」を参照)。
- `scenarios` には、scenario の実行ごとに 1 件のエントリが、終わった順に入り、それぞれが走った `environment` を持ちます。
  各 step は、feature ファイルでの `line`、`text`、一致した `step`(一致がないか複数あれば `null`)、`status` を持ちます。
  始まった step は、`step_record_id`(`nuka do --use` が受け取る値)と、step record のディレクトリである `record` を持ち、その `mutates` の宣言と `observed` の計測も持ちます。
  step record を読み戻せなかった step は、その代わりに `record_unreadable: true` を持ち、`step-record-unreadable` の警告がそのファイルを名指します。
  失敗した step、または理由があって始まらなかった step(`undefined`、`ambiguous`)は、step record の `kind`(step record が言わなければ `null`)と最初のメッセージを持つ `error` を持ちます。
  `from` で前の結果を読んで失敗した step は `used` を持ち、各 producer の step、record、読んだ結果を載せます。
  JSON が 4096 バイトを超える結果は、代わりにプレビューになり、`truncated: true` と、値全体の大きさである `result_bytes` を持ちます。
  object のプレビューは、収まるかぎり、最上位の数、真偽値、null と、最上位の各文字列の先頭 1024 文字を残すので、process の `exitCode` と `stderr` の始まりは残ります。
  値全体は producer の `record` にあります。
  args と step 自身の結果は step record に残ります。
  大きくなりうるうえ、次の判断には要らないからです。
- 失敗した scenario は、それだけを走らせるコマンドである `do` を持ちます。
  `scenario-failed` の所見の `do:` 行が出すのと同じコマンドです。
  自分の evidence(最終スクリーンショット、hook の trace や添付)を書いた scenario は、run の `scenarios/` の下のそのディレクトリを `evidence` に持ちます。
  何も書かなかった scenario は `evidence` を持たず、その空のディレクトリは run の終わりに消されます。
- すべての scenario は `criteria` を持ちます。
  `changed_since` は、`--since` がなければ `null` です。
  あれば `unchanged`、`changed`、`new`、`ambiguous`、`unknown` のどれかで、後の 2 つは `reason` を持ちます。
  unchanged ではない scenario は現在の `lines` を、どれも名指す `step_files` を持ちます。
  `since` は、フラグがなければ `null` です。
  あれば `ref`、その `commit`、比べた対象の `compared`、消えた受け入れ基準の `removed`、各 step ファイルの `file` とその `change`(`unchanged`、`changed`、`untracked`)を持ちます。
- `findings` は、run が出したすべての所見を持ちます。
  失敗した各 scenario と、各 note と、各警告(書けなかったファイル、失敗した hook や fixture の teardown、例外を投げたバージョン probe)で、テキストのとき stderr に出るのと同じ所見です。
- `verdicts` は scenario と environment の組ごとに 1 つのセルを持ち、feature はパス順、scenario は行順、environment は与えた順に並びます。
  セルの中の実行が 1 つでも失敗していれば `verdict` は `failed` で、`executions` はその数(`--repeat` のとき 2 以上)、`passed` は通った数です。
  選んだ scenario がある environment で一度も走らなかったとき(その environment の BeforeAll が失敗したときなど)は、`verdict` が `not-run` で実行が 0 のセルになります。
  run サマリが描く表はこれです。
- `counts` は、実行を数える `scenarios`、`passed`、`failed` と、`not-run` のセルを数える `not_run` を持ちます。
- BeforeAll や AfterAll の失敗は、その environment を名指す `hook-failed` の所見になり、その `do` は同じ対象をその environment で走らせます。
- `verdict` は終了コードの断定です。
  どの scenario も持たない BeforeAll や AfterAll の失敗も数えるので、`counts.failed` が 0 でも `failed` になることがあります。

`run.json` の中のパス(step の `record`、`used` のエントリの `record`、scenario の `evidence.dir`)はすべて、`run.json` 自身を持つ run ディレクトリからの相対パスです。
CI からアップロードした run ディレクトリを別の場所にダウンロードしても、同じように読めるからです。
stderr の書き込み先の行は、このファイルを `run` として、プロジェクトのルートからの相対パスで示します。
scenario を 1 つも選ばなかった run は record を書かず、`run.json` も書きません。
強制終了された run にもありません。
retention は、それによって終わった run と見分けます。
scenario record のファイルはありません。
`run.json` の中の scenario のエントリが、その record です。

`--json` は、同じ文書をファイルとバイト単位で同じまま stdout の唯一の JSON 文書として、`--records` が出力する scenario の行の代わりに出力します。
スクリプトは 1 回の解析で結果全体を読めます。
scenario を 1 つも選ばなかった run でも、空の `scenarios` とともに出力します。
何かが実行される前の拒否では、`--json` なしのときと同じく stdout に何も出力しません。
stderr は変わりません。

書き込み先の行が名指すのは、その run が書いたもの、つまり step record と run サマリです。
`nuka report` は、run の後に自分が書くパスを同じやり方で名指します(「Allure results」と「Messages stream」を参照)。

`run.json` の scenario 自身の `browser` フィールド(`{ "type": "firefox", "version": "133.0" }`)には、この run が実際に起動したエンジンとバージョンが入ります。
これは Playwright が返す実際の `Browser` オブジェクトから読んだ値であり、`config.browserType` から読んだ値ではありません。
両者は食い違うことがあります(step が `page` fixture をこの run 自身の `ctx` が一度も起動していない別のブラウザで上書きすることがあるからです)。
記録に足るだけの信頼性があるのは計測された側だけです。
run の pickle が一度もブラウザを起動しなかった場合、このフィールドは何らかの既定値になるのではなく、存在しません。
`page`、`context`、`pageAs` を分割代入しない step だけの pickle は何も起動せず、このフィールドが一度も走っていないブラウザを名指すことはありません。

`:12` は 1 つの scenario だけを選び、これが反復のための経路です。
feature のフル実行はすべての scenario の分数を消費し、その中の 1 つを正しくすることが、たいてい次の数回の実行の目的です。
これは同じものの縮小版ではありません: 部分実行の run サマリは選んだ scenario しか扱わないので、green になったところでそれはデバッグの結果でしかなく、レビュアーが feature が通ったと読むべきものではないからです(「レビュー」を参照)。
行番号が与えられ、それがファイルの持つ scenario より少ない数を選んだとき、`run.json` と run サマリは `selection: partial` でそれを告げます。
行番号がファイルのすべての scenario を選ぶ場合(scenario が 1 つの feature など)、それはすでにフル実行なので、`selection` は `full` です。

1 つの pickle 内の step は 1 つの context を共有します(Cucumber ユーザーが期待する World の意味論です)。
ログインする Background は、以降のすべての step にブラウザと cookie を引き継ぎます。
失敗した step は scenario の残りをスキップし、スキップされた step には step record が作られません(始まってすらいない実行が引用可能であってはならず、「skipped」と言うのは `run.json` の scenario のエントリの役目です)。
Evidence は自然なスコープに従います。
各 step の record は、その step 自身の http.jsonl と、その step 自身の Playwright trace の両方を持ちます。
trace はかつて、共有された context 全体にまたがる 1 本のファイルとして scenario 自身のディレクトリに置かれ、`page` を bag に名指した最初の step で一度だけ開かれ、最後に一度だけ閉じられていました。
今は step の境界ごとに切られ、ブラウザに一度も触れない step にはそもそも trace の chunk が無く、触れた step にはその step 自身の操作だけが入った chunk があります(これは step 自身の fixture bag がすでに持っていた「必要な名前だけ構築する」という性質と同じ切り方です)。
落ちた step の trace を直接開けるほうが、何が起きたかを scenario 全体の録画からスクラブして探すより速く、それがこの変更の理由のすべてです。
シナリオ全体の 1 本の trace がついでに与えていたもの、つまり全 step をまたいだネットワークの通し view は、step ごとの trace には無くなります。
各 step 自身の trace にはその step 自身の通信は変わらず入っているので、1 つの step 単体の通信について失われるものは無く、失われるのは scenario 全体の通信を 1 つのファイルだけ開いて眺められるという点だけです。
`request` fixture の通信と page 自身の通信は、いまや同じ step ごとの view を共有します。
どちらも同じ http.jsonl に載り、各エントリには `via: "request"` か `via: "page"` の印が付くため、読み手はどちらの経路が通ったかを推測せずに済みます。
`page.request` と `context.request` の呼び出しも `via: "request"` です。
それらは page とその browser context に Playwright がぶら下げる APIRequestContext であり、`request` fixture と同じ種類の呼び出しで、page の `request` イベントは発火しません。
`via: "page"` として載る page 由来のリクエストは `document`/XHR/`fetch` の 3 種類だけです(1 回のページ読み込みは画像やスタイルシート、スクリプトの束を何十件も引き込みうるため、それを全部保持しようとするファイルは読み手が開けるものではなくなってしまいます)。
ただし落とされたことが黙って消えるわけではありません。
落とされた分は step record 自身に、リソースタイプ別に `http_omitted` として載ります(「Records」を参照)。

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
nuka do create-project --args '{"name":"acme"}' [--env <name>]
nuka do archive-project --use step-20260801-143022-a1b2
```

1 つの型付き step を実行し、その step record を stdout に出力します(ok なら exit 0、failed なら 1)。
step、その fixture、または step ファイルが `console.log` や `process.stdout.write` で書いたテキストは stderr に渡されるので、その record は 1 つの JSON 値のままです。
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
id はまず `do/` で、次に各 run の `steps/` で探されるので、`nuka do` の呼び出しの step record も `nuka run` の step record も解決できます。
実際に取り出された record id はこの実行自身の `used` に載るので、複数回の `do` 呼び出しにまたがって手で組み立てた chain も、scenario が駆動した chain と同じくらい後から追跡できます。

`--use` が運ぶのは値そのものであり、それが指すものがまだそこにあるという保証ではありません。
上流の step が返した path は、fixture が所有するリソースを指していることがあります。
`do` の下では 1 回の実行が fixture の scope のすべてなので(「Fixtures」を参照)、後から別の `--use` 呼び出しがその path を読み込む時点では、その fixture はすでに teardown 済みかもしれません。
返り値が fixture が teardown するものを指しているかどうかは、schema からも step 自身のコードからも読み取れません。
だからこれは、実行より前に `check` が捕まえられる間違いではありません。

`do` の下で通った step は、それだけでは `run` の下でも通ることが示されたわけではありません。
`do` はすべての実行にそれぞれ専用のブラウザとそれ以外のすべてを与えますが、scenario はそのすべての step に 1 つの context を与えるので、2 番目の step は 1 番目が残したものをそのまま引き継ぎます(すでにログイン済みかもしれず、別のページにいるかもしれず、ダイアログが開いたままかもしれません)。
この 2 つの問いは別物であり、どちらの答えも他方の代わりにはなりません: `do` はその step が動くかどうかを問い、`run` はそこで動くかどうかを問います。
ログイン状態も含めて、`do` の呼び出しをまたいで持ち運ばれるものはありません。
ログイン状態が必要な step は、それを fixture から得ます。
これがいちばん厳しく効くのは、自分自身の setup が 2 回目の実行では no-op になってしまう step で、直すべきは engine ではなく feature の側です: 状態は step ごとに毎回立てるのではなく、それを行うと名前が言っている step の中で一度だけ立てます。

### 繰り返せない状態

ここまではすべて、何もない状態から始まります。
`nuka do` は実行のたびに専用のブラウザとそれ以外のすべてを与え、それが 1 回の呼び出しを単独で読めるものにする一方、探索を高くつくものにもします: 20 番目に試したいことの前には、19 個のことが立ちはだかります。
読み取りだけならこれは遅いだけで済みます。
繰り返せない作業、たとえば一度しか開けないアカウントや二重に発行されてしまう請求書では、それすら不可能です。

nukadoko は、そのために世界を開いたまま保持することはしません。
agent のホストはすでに Playwright MCP サーバを動かせます。
このサーバは呼び出しをまたいで 1 つのブラウザを開いたまま保ち、agent は直前の呼び出しが残したページの上で操作できます。
nukadoko skill は、状態を繰り返せないブラウザのアプリについては agent をそちらへ向かわせ、そのサーバがつながっているかどうかの見分け方も示します。
nukadoko 自身のプロセスで同じことをすると、管理すべき 2 つ目のブラウザ、生の認証情報を保持する socket、アイドルタイムアウトが増えます。
それでいて、ホストのサーバがすでにしていること以上のものは何も得られません。

そのサーバがすることは何も evidence にはなりません。
step record も `run.json` も書きません。
レビュアーが読む run サマリは `run.json` から組み立てられます(「レビュー」を参照)。
だから探索からそのサマリへの道は、誰かが書いた feature と本物の `nuka run` を通るか、そもそも存在しないかのどちらかです。
30 回の呼び出しを経た世界は、誰にも再現できません。
だからこそ、探索から出てくるのは、それをもとに書かれ、`nuka check` で確かめられ、ゼロからもう一度実行される scenario です。

## Records

step record は、1 回の step 実行に対するツールの計測を含みます。
step が scenario 内で実行された場合も、`do` で実行された場合も形は同じです。
scenario record(「実行」を参照)は、次の粒度で同じ問いに答えます。
1 つの pickle の run が、順序付けられた step 全体で何をしたかを示します。
2 つの record は、同じ概念を異なる粒度で示します。
scenario record は独立したファイルではなく、その run の `run.json` の中の scenario のエントリです。
その `steps` 配列は各 step record を id とパスで示し、step record は自分の scenario record の id を持つので、どちらの record からでも他方にたどり着けます。

```json
{
  "schema_version": 4,
  "nukadoko": "...",
  "step_record_id": "step-20260801-143022-a1b2",
  "step": "create-project",
  "kind": "do",
  "args": { "name": "acme" },
  "args_origin": { "name": "command_line" },
  "result": { "id": "p_0001", "name": "acme" },
  "status": "passed",
  "mutates": true,
  "observed": { "processes": null, "http": 1, "files": null, "unmeasured": [] },
  "environment": "dev",
  "target_version": "1.4.2+abc123",
  "scenario_record_id": null,
  "run_id": null,
  "started_at": "...",
  "finished_at": "...",
  "evidence": {
    "dir": ".nukadoko/do/step-20260801-143022-a1b2",
    "trace": "trace.zip",
    "screenshots": [{ "file": "final.png", "at": "..." }],
    "http": "http.jsonl"
  }
}
```

- `schema_version` が先頭に来るので、読み手は残りを読む前に、どの形を持っているかを確かめられます(「CLI summary」を参照)。
  `nukadoko` は record を書いたバージョンです。
  `run.json` も、envelope のものとして両方を持ちます。
- `result` は信頼の錨です。
  returns のスキーマを通過しており、それを作ったのは(呼び出し側ではなく)ツールです。
  失敗時には `error: { kind, message }` がそれに置き換わります。
  compat の step は `result: null` を記録します。
- `args` も同じ分かれ方をします(この背後にある拒否については「型付き step」を参照)。
  `passed` な record では `run` が実際に受け取った、スキーマで検証済みの値です。
  呼び出し側が書かなかったキーにスキーマ自身の `.default(...)` が入った場合も含みます。
  `failed` な record では与えられたものをそのまま保持します。
  スキーマがすでに拒否した値を、検証済みの形に組み立て直すことはできないからです。
  compat の step の `args` は、検証対象のスキーマが無いため、どちらの結果でも検証されません。
- `args_origin` は、`args` の各キーの出所を示します。
  `"capture"` は pattern の capture です。
  `"docstring"` と `"table"` は feature の行に付いたものです。
  `{ "from": { "step_record_id", "step", "key" } }` は前の step の result で、scenario の中の `from` か `nuka do` の `--use` を通したものです。
  `key` は読んだ result のキーです。
  `"command_line"` は `nuka do --args` です。
  `"schema"` は、検証の間に args のスキーマがそのキーを作ったことを示します(`.default(...)` や transform)。
  間違った値を見つけた読み手は、feature の行、step、上流の record を手で突き合わせずに、どの入力を直すべきかが分かります。
  位置で引数を受け取る compat の step と、キーのない args では現れません。
- bigint は、`args` でも `result` でも record のほかのどこでも、10 進数の文字列として保存されます。
  JSON には bigint が無いからです。
  `{biginteger}` のキャプチャを `z.bigint()` に結び付けると、`"v": "123456789012345678901234567890"` と記録されます。
  1 つの `nuka run` の scenario の中では、`from` の連鎖は次の step に bigint そのものを渡します。
  `nuka do` は `--use` の値を保存された record から読み、`--args` を JSON として読みます。
  そのため、step の `args` スキーマが bigint や Date を期待するところでは、保存された文字列を先にそれへ戻します。
  それ以外の文字列は、文字列のままスキーマに届きます。
  このとき読むのは、スキーマが受け取る側の型です。
  `z.coerce.bigint()` へ pipe した文字列、文字列を decode する codec、`z.preprocess()` の関数は、与えられた文字列をそのまま受け取ります。
  `z.bigint().transform(...)` は bigint を受け取ります。
  union のどれかの選択肢が、与えられた文字列をそのまま受け付けるなら、選択肢を宣言した順序にかかわらず、文字列はそのまま残ります。
- `scenario_record_id` と `run_id` は、この実行が何に属するかを名指しします。
  `run`-originated な step(`kind: "run"`)では所属する scenario record の id と `nuka run` 呼び出し自身の id、`do`-originated な step ではどちらも `null` です(`do` はどの scenario にも run にも属さないため)。
  `run_id` が無かったころは、ある step record がどの run のものかを知るのに別のファイルを開く必要がありましたが、いまは step record 自身が、この 1 回の実行が何をしたかについてすでにそうしているのと同じように、それに自分で答えます。
- `error.kind` は閉じた集合を使い、人が読むメッセージの隣に置かれます: `args_invalid`、`result_invalid`、`binding_invalid`、`world_invalid`、`timeout`、`unsupported`、`step_error`。
  閉じているのは、レポートがこれに対して分類を行うからです(step ごとに拡張される開いた集合では、何も分類できません)。
  最初の 4 つは、契約があるからこそ存在する失敗を指し、return 値を捨てる runner の上に作られたレポートでは埋められない部分です。
  確信が持てない分類器が `step_error` を返すのは、契約違反を誤って主張するほうが、主張しないより悪いからです。
  scenario record の中の hook record も同じフィールドを持ちます。

  | `error.kind` | step が失敗した理由 |
  | --- | --- |
  | `args_invalid` | args が step の `args` スキーマに合わなかった |
  | `result_invalid` | 返した値が step の `returns` スキーマに合わなかった |
  | `binding_invalid` | feature の行のテキスト、テーブル、doc string を step の args に bind できなかった(`nuka run` のみ) |
  | `world_invalid` | 宣言された World のキーへの書き込みが `defineWorld` のスキーマに合わなかった |
  | `timeout` | step または hook が決着する前に期限が来た |
  | `unsupported` | nukadoko が実装していない compat の形(`done` コールバック、または `"pending"` や `"skipped"` を返した) |
  | `step_error` | それ以外で、step または hook 自身のコードが throw した |

- `mutates` は step 自身の宣言を保持します(compat の step には記録すべき宣言がないため `null` になり、`false` にはなりません)。
  step record が計測したものと並んで置かれるため、宣言された値と計測された値を別の artifact なしに比較できます。
- Evidence は harness によって収集され、step が自己申告することは決してありません。
  ブラウザが使われるときは Playwright の trace とスクリーンショット、`request` fixture の呼び出し、`page.request` と `context.request` の呼び出し、page 自身の document/XHR/fetch の通信はすべて http.jsonl に記録され、step record 自体が一次記録になります。
- `evidence.screenshots` は browser context ごとに 1 つのエントリを持ちます。
  デフォルトの context は `{ "file": "final.png", "at": "..." }`、`pageAs(name)` の context はそれぞれ `{ "file": "final.<name>.png", "at": "...", "as": "<name>" }` で、デフォルトが先です(「1 つの scenario の複数の人」を参照)。
  `pageAs` の context がある step で書いた trace チャンクは、`evidence.trace` の隣の `evidence.named_traces` に `{ "as", "file" }` として載ります。
  その context からの `actions`、`page_events` のエントリ、http.jsonl の行は `as` を持ちます。
  ブラウザを使う実行の evidence は以前は 2 つのファイルで、step が失敗するたびに同じバッファを別名でもう 1 つ保存していました。
  それを書くこと自体にコストは無かったものの、ツールが一度も計測していないことを暗に主張していました。
  「失敗」スクリーンショットが、最後に撮られたものとは別個の事実として存在するという主張です。
  実際にはそうではありませんでした。
  スクリーンショットは `run` がすでに返るか投げたあとに一度しか撮られないため、その 2 つ目のコピーは、それが名指す失敗に対してすでに古びている可能性がありました。
  `at`(ISO 8601。
  `started_at`/`finished_at` と同じ形式)は、その 2 つ目のファイルが一度も明言せずに肩代わりしていたものを、実物として言い当てます。
  この実行自身のタイムラインから何秒後にそのスクリーンショットが実際に撮られたか、です。
- `observed` は、その実行が届いたものとしてツールが見たものを、チャネルごとに 1 つのキーで持ちます。
  キーは `processes`、`http`、`files`、`unmeasured` です。
  どのチャネルも 1 つの規則に従います。
  正確に計測できるものは計測し、計測できないものはそうと印を付け、メソッドから書き込みを推測しません。
  実行が一度も届かなかったチャネルは `0` ではなく `null` です。
  「何も計測しなかった」と「0 を計測した」は別の事実だからです。
  `unmeasured` は常にリストです。
  見えたが計測できなかったものを挙げるリストです。
  空のリストは、下の差し替えが計測できないものを何も見なかったことを言います。
  どの差し替えも届かないもの(この項目の終わり)については、何も言いません。
  step が書き込んだかどうかを述べるフィールドはありません(「キーワードの意味論」を参照)。
  POST はリクエストであって書き込みではなく、ファイルが `files` に載るのはディスク上のそのファイルの同一性が変わったからです。
  チャネルを記録するのは、step 自身の `run`、それが呼ぶ part、compat step の関数の中です。
  executor はその周りにスコープを開きます。
  nukadoko は `fetch`、`node:http`、`node:https`、`node:child_process`、`net.Socket#connect` と `write` と `end`、`node:fs` の書き込み、`worker_threads.Worker`、`dgram.Socket#send` をプロセスごとに 1 回だけ差し替え、そのスコープに記録します。
  step の外では、差し替えたものは元の関数を呼ぶだけで、何も記録しません。
  差し替えたどの関数も、元の関数の `name`、`length`、promise の形(`exec` と `execFile` の `util.promisify`)、同期的な throw を保ちます。
  そのため step の外のコードには、Node が出荷したとおりの組み込みに見えます。
  step の中でも、記録が step のコードへ throw したり run を終わらせたりすることはありません。
  元の関数が拒む引数(ホストを持つ file URL、Symbol)は元の関数に届き、step は step の外と同じく元の関数自身のエラーを受け取ります。
  step の中の nukadoko 自身の I/O は、step のものとして記録しません。
  `runCommand` の起動、ブラウザの起動、`request` fixture の呼び出しの送信(その行がすでに記録します)、state ディレクトリの下への書き込みがそれです。
  Playwright のサーバ側のコードが行う書き込みも、どのコードがブラウザを起動したかによらず、step のものとして記録しません。
  trace のチャンク、ネットワークのログ、リソース、HAR、動画がそれです。
  Playwright のサーバは step 自身のプロセスと非同期コンテキストで動きます。
  そのため、これがなければ、context のオプションをヘッダと資格情報ごと持つ trace の書き込みが、step のファイルとして読まれてしまいます。
  `node:fs` の差し替えは、書き込み先のディレクトリではなく、呼び出しを行ったコードを呼び出しスタックから読んで、この 2 つを見分けます。
  Playwright のクライアントからの書き込みと、step が渡したパスでクライアントの呼び出しを実行するサーバのコードからの書き込みは、step のものです。
  そのため `page.screenshot({ path })`、`context.storageState({ path })`、`download.saveAs(path)`、`tracing.stop({ path })` が書く zip は載ります。
  Playwright のサーバからのそれ以外の書き込みは載らず、それを仕上げるために Node が行うこと(再帰的な `rm` が消すエントリ)も載りません。
  起動が `tracesDir` を名指さないとき、Playwright は trace の呼び出しスタックを自分の一時ディレクトリに置き、step の中の `tracing.stop` は step の呼び出しの一部としてそれを消します。
  そのため record は、そのディレクトリを removed として載せます。
  nukadoko が起動するブラウザは、起動の `artifactsDir` と `tracesDir` に書き、動画は context の `recordVideo.dir` に書きます。
  `config.browser` と `config.browserContext` が名指せばそのディレクトリで、名指さなければ nukadoko が実行の evidence directory の中に作り、ブラウザを閉じるときに消すディレクトリです。
  state ディレクトリの中にあるので、それを飛ばした終了のあとは、retention と `nuka clean` が消します。
  差し替えより前に `fetch` や `http.request` を変数に写したモジュールは元の関数を持ち続けます。
  そのため `nuka run` と `nuka do` は、config や step のファイルを読み込む前に差し替えを入れます。
  インターセプタは、どちらの順で入れても動き続けます。
  どの差し替えも、すべての引数をそのまま渡し、元の関数が返したものを返すからです。
  Node 22.22.0 で msw 2.15.0 と nock 14.0.17(どちらも @mswjs/interceptors 0.41.9 の上)を使い、step の中でモックした `node:http` の GET と `fetch` を 1 つずつ送って計測しました。
  差し替えより前に入れた場合は、どちらのリクエストもモックのレスポンスを持つ行になりました。
  差し替えより後に入れた場合は、`node:http` のリクエストは行になり、`fetch` はなりませんでした。
  インターセプタの `fetch` が、自分が置き換えた `fetch` を呼ばずに答えるからです。
  Worker 自身のグローバル、ネイティブアドオン、子プロセス自身の通信、差し替えより前に写された関数、差し替えより前に開いた接続、step より前に開いた接続を step が読むだけのときにその接続が運ぶもの、step の非同期コンテキストの外で動く処理(fixture が始めたサーバが呼ぶコールバック、ダウンロードが終わる前に呼んだ `download.saveAs` など)には、どの差し替えも届きません。
  ダウンロードが終わる前に呼んだ `download.saveAs` は、ブラウザが終わりを知らせたときに Playwright が実行します。
  これらは `unmeasured` に載りません。
- `observed.processes`(実行が一度も `runCommand` を呼ばなかったときは `null`)は、その実行の間に `runCommand` が起動した子プロセスを、呼び出し順に並べます。
  各エントリは `{ "command", "cwd", "exit_code", "duration_ms" }` です。
  シグナルがプロセスを終了させた場合は `"signal"` が加わり、`timeout` オプションがプロセスを止めた場合は `"timed_out": true` が加わります。
  `command` は配列で、プログラムとその引数を順に持ちます。
  `command` は、ほかのフィールドと同じく redact されます。
  step の中では、各エントリに `"files"` も加わります。
  これは、起動の前と終了の後に `cwd` をたどった結果の差で、`added`、`changed`、`removed` のパスを `cwd` からの相対パス(区切りは `/`、ディレクトリは末尾に `/`)で並べます。
  サイズ、更新時刻、変更時刻、inode のどれかが違えば変更とみなすので、同じバイト列での書き直しも載ります。
  ファイルの中身は読みません。
  `node_modules` と `.git` のディレクトリ、そして run 自身が書き込む project の state ディレクトリはたどらず、`"skipped"` に名前を載せます。
  エントリが 20000 を超える作業ディレクトリや読めない作業ディレクトリでは、代わりに `{ "unmeasured": "<理由>" }` になります。
  計測するのはプロセスではなくディレクトリなので、同じときにそこへ書き込んだほかのものも差に含まれます。
  プロセスがその stream に書き込み、実行に evidence directory があるときは、各エントリに `"stdout"` と `"stderr"` も加わります。
  値はその directory にあるファイルの名前(`process-<n>.stdout.txt` または `process-<n>.stderr.txt`)で、ファイルは stream の全体を持ちます。
  中身は http.jsonl と同じく redact され、step 自身の `redact` の値も置き換えられます。
  出力をフィールドではなくファイルにするのは、出力は大きくなることがあり、`run.json` が写すエントリを小さく保つためです。
  step がプロセスに `input` を書いたときは、`"stdin"` がそれを持つ `process-<n>.stdin.txt` を指します。
  中身は同じように redact されます。
  各エントリには `"env"` も加わります。
  これはランナーの環境変数に対するプロセスの環境変数の差で、`{ "added": {...}, "changed": {...}, "removed": [...] }` か、step が `env` を渡さなかったときは `{ "inherited": true }` です。
  環境変数の全体ではなく差にするのは、ランナーの環境変数は step について何も言わない変数を何十も持ち、その一部は資格情報だからです。
  名前はすべて記録され、`removed` は名前のリストです。
  値を見せるのは、資格情報ではないと nukadoko が判断できるときだけです。
  それは、制御文字を含まず、プロセスが終わったときに存在する絶対パス(`/...`、または `C:\...` のような Windows のドライブのパス)、10 進の整数、`true` か `false` で、エントリのほかの部分と同じく redact されます。
  それ以外の値は `{ "hidden_bytes": <n> }` で、UTF-8 のバイト長です。
  ここでは、読み込んだ secret を redact するだけでは足りません。
  step は、自分で持つ値(step が署名したトークンなど)を `env` で渡すからです。
  record が資格情報の漏れる場所になってはいけません。
  それでも、step を判断する読み手にはパスと数値が必要で、バイト長は値が空かどうかを伝えます。
  パスが存在することを求めるのは、形だけでは何も証明できないからです。
  base64 は `/` で始まることがあるので、トークンがパスに見えることがあります。
  しかし、トークンはどのファイルも指しません。
  その結果、プログラムに作るよう伝えたのに作られなかったパスは隠されます。
  `n` は実行の中のプロセスを 1 から数えます。
  1 つの scenario の hook が同じ directory を共有するときは、空いている次の番号に進みます。
  step を確かめる人には、プログラムが出力したものが必要です。
  step の result には、step が返すと決めた部分しか残りません。
  step 自身が持つ値(step が署名したトークンなど)は読み込んだ secret ではありません。
  `redact: { NAME: value }` を渡すと、その値は `command` の中で `{{secret.NAME}}` と書かれ、プログラムには本当の値が渡ります。
  `runCommand(command, args, { cwd, env, input, timeout, redact, files })` は `nukadoko` からの import であり、fixture ではありません。
  0 以外を含むすべての終了で `{ exitCode, signal, stdout, stderr, files }` に resolve し、reject するのは、プログラムを起動できなかった場合と `timeout` がプロセスを止めた場合だけです。
  `files` はエントリの `"files"` と同じ値です。
  そのため、「このコマンドは何も書かない」を主張する step は、自分でディレクトリをたどらずに、この計測を返せます。
  `files` は step の中では必ずあり、step の外では `files: true` を渡したときだけあります。
  Windows では、`npm` のような拡張子のないプログラム名を `PATH` と `PATHEXT` で探し、`.cmd` と `.bat` のファイルは `cmd.exe` を通して各引数をそのまま渡して実行します。
  そのため step はどのプラットフォームでも同じ名前でプログラムを指定でき、`command` には step が書いた名前が残ります。
  step の `run`、part、compat step の中の呼び出しはエントリを加えます。
  それ以外の場所の呼び出しは同じように動き、エントリを加えません。
  step がほかの手段(`node:child_process` の直接利用)で起動したプロセスは計測されず、代わりに `observed.unmeasured` に載ります。
  step の record を作る時点でまだ動いているプロセスは載りません。
  step の record を書いたあとに step のコードが起動したプロセス(残したタイマーから、またはタイムアウトのあとに)は、その step のものであり、そのとき動いている step のものではありません。
  record は確定しているので、そのエントリは record の隣に `"after_step_end": true` を付けた `process-<n>.json` として書かれ、出力のファイルはいつもどおり書かれ、run サマリがそれを数えます(下の `after_step_end`)。
- `observed.http`(実行が何も送らなかったときは `null`)は、step 自身のプロセスが `fetch`、`node:http`、`node:https`、または Playwright の request context(`request` fixture、`page.request`、`context.request`)を通して送ったリクエストを数えます。
  各リクエストは step の http.jsonl(下の `evidence.http`)の 1 行で、本文を持ちます。
  page 自身の通信は数えません。
  送ったのはブラウザであり、その http.jsonl の行と trace がすでにそれを持つからです。
  step のコードが自分で作った request context(`playwright` の `request.newContext()` で、compat の World が作ることがあります)は step 自身のプロセスから送るので、そのリクエストは `via: "node:http"` か `"node:https"` の行です。
  step の record を書いたあとに step のコードが始めたリクエストは、ここでは数えません。
  その行は、`"after_step_end": true` を付けて、その step の http.jsonl に書かれます。
- `observed.files`(実行が何も変えなかったときは `null`)は、step が変えたパスを並べ替えて並べます。
  各エントリは `{ "path", "change", "bytes", "content" }` です。
  2 つの出どころをまとめます。
  1 つは scratch のディレクトリ(「Context API」を参照)の、step の `run` の前と後の比較です。
  これは `runCommand` の子プロセスを含むどのプロセスの書き込みも見ます。
  step の間に作られた scratch のディレクトリは、空のディレクトリと比べます。
  もう 1 つは、step 自身のプロセスの `node:fs` の書き込みの呼び出し(`writeFile`、`appendFile`、`mkdir`、`rm`、`rename`、`copyFile`、書き込みフラグ付きの `open`、書き込み stream と、それぞれの sync 版と promise 版)です。
  これは state ディレクトリの外のどこのパスでも名指し、最初の呼び出しと step の終わりとでそのパスの同一性(サイズ、更新時刻、変更時刻、inode)が違えば、そのパスを数えます。
  したがって、失敗した呼び出し、すでにあるディレクトリの `mkdir`、step の中で作って消したファイルは載りません。
  `lstat` の `ENOENT` と `ENOTDIR` は、そのパスが存在しないことを示します。
  最初の呼び出しか step の終わりで同一性を読めないパス(`lstat` が `EACCES`、`ELOOP` などのエラーで失敗したもの)は、どちらの種類の変化でもありません。
  そのパスは kind が `files` の `unmeasured` のエントリ `<path> could not be inspected: <code>` になり、run は続きます。
  両方の出どころが同じパスを名指すときは、scratch の比較が勝ちます。
  project のルートはたどりません。
  たどると多くの step の所要時間より長くかかり、dev サーバの書き込みを step のものと読んでしまうからです。
  `path` は絶対パスで、ディレクトリは末尾に `/` が付きます。
  `change` は `added`、`changed`、`removed` のどれかです。
  `bytes` は step の後のファイルのサイズで、`content` は step の後のそのテキスト(下記)です。
  `content` は 1 ファイルあたり 8 KiB までです。
  step がファイルの中身を読むのは全部で 64 KiB までで、テキストでもバイナリでも、読んだバイトはすべてこの上限に数えます。
  バイナリのファイルはテキストを残しませんが、読む手間は同じだからです。
  step の上限を超えたファイルは開きません。
  その `bytes` は `lstat` によるサイズで、`content` は `{ "text": "", "bytes", "truncated": true }` です。
  ディレクトリと消えたパスはどちらも持ちません。
  `run.json` は `content` を除いてリストを写します。
  20000 を超えるパスに書いた step では、最初の 20000 が載り、残りについて `unmeasured` のエントリが 1 つ加わります。
  比べられなかった scratch のディレクトリも `unmeasured` のエントリになります。
- `observed.unmeasured` は、step が行い、ツールには見えたが計測できない操作を、異なる操作ごとに 1 回ずつ `{ "kind", "detail" }` で並べます。
  `child_process` は `runCommand` ではなく `node:child_process` で起動したプロセスです。
  `detail` は、その呼び出し、プログラムの名前(パスの最後の部分をどちらの区切り文字でも切り出したもの、またはシェルのコマンドラインで `NAME=value` の代入ではない最初の語の、同じ最後の部分)、渡された引数の数で、たとえば `execFile git with 2 arguments` です。
  引数は載せません。
  そのプロセスは計測しておらず、step は自分が持つトークンを、ほかのどこへでも渡すのと同じくらい簡単にコマンドラインへ渡します。
  しかもこれらの呼び出しには、それを名指す `redact` のオプションがありません。
  同じ理由で、`detail` は `=` を含む語を持ちません。
  代入は数えず、`=` を含むプログラムの名前は `(name hidden: it holds an equals sign)` になります。
  シェルのコマンドラインは POSIX のシェルと同じように語に分けます。
  ただし Windows の上と `cmd.exe` のシェルでは、バックスラッシュはパスの区切り文字で、語をまとめるのはダブルクォートだけです。
  呼び出しは、プロセスを起動していれば、そのプロセスがどう終わっても記録します。
  プログラムが 0 以外で終了した、または時間切れになった `execSync` や `execFileSync` も記録し、step はその呼び出し自身のエラーをそのまま受け取ります。
  引数で throw した呼び出しや、プログラムが見つからなかった呼び出しは何も起動しておらず、記録しません。
  コマンドを記録したい step は、それを `runCommand` で起動します。
  `worker_thread` は `worker_threads.Worker` です。
  そのグローバルにはどの差し替えも届かず、`detail` はそのスクリプトを名指します。
  `socket` は、記録したリクエストのどれにも属さないクライアントの通信で、step の record を作るときに判定します。
  step が開いた接続(データベースのクライアント)では、`detail` は `connect <host>:<port>` か socket のパスです。
  step より前に開いた接続に step が書いた場合(fixture が開いたプール、keep-alive のクライアント)は、接続ごとに 1 回、`write to <host>:<port>, a connection opened before the step` です。
  Upgrade した接続や CONNECT のトンネルがハンドシェイクのあとに運ぶものは、`traffic after the upgrade of <url>` か `traffic through the CONNECT tunnel to <host>:<port>` です。
  そのハンドシェイクのリクエストは、それ自身の行になります。
  step が `node:dgram` で送った UDP のデータグラムには記録するレスポンスがなく、宛先ごとに 1 回、`send to <host>:<port>` です。
  接続済みの socket では、宛先は接続先です。
  接続は、nukadoko 自身の I/O が開いたとき、または `fetch`、`node:http`、`node:https`、`request` fixture、ブラウザからの記録したリクエストを運ぶときに、計測済みと数えます。
  agent がいつその接続をリクエストに渡しても同じで、少し遅れて接続する proxy の agent も含みます。
  判定するのは `Socket#connect` を呼ぶ接続だけです。
  そのため、コンソールの出力、`process.stdout` と `process.stderr`、`runCommand` が書く stdin、サーバが受け入れた接続、`--concurrency` の worker プロセスが使う IPC のチャネルは、これに当たりません。
  `files` は、比べられなかった scratch のディレクトリ、step が書いたパスのうち同一性を読めなかったもの、またはパスの上限を超えた step です。
  run サマリは、ここにエントリがある step ごとに 1 行を載せ(下の run サマリを参照)、エントリがない step については何も加えません。
- `after_step_end`: step のコードは、残したタイマーから、またはタイムアウトのあとに、record を書いたあとも動き続けることがあります。
  そのとき始めたリクエストや `runCommand` のプロセスは、その step のものであり、そのとき動いている step のものではありません。
  どの境界も、開いたときの evidence のディレクトリを持ち続けるからです。
  record は確定しており書き直さないので、その操作は record の隣に `"after_step_end": true` を付けて書かれます。
  リクエストはその step の http.jsonl の行に、プロセスは `process-<n>.json` のエントリになります。
  scenario record の step のエントリと `run.json` の step は、`"after_step_end": { "requests", "processes" }` を持ちます。
  これは scenario が終わる前に始まったものの数です。
  リクエストを始めたときは `"http": "http.jsonl"` も加わります。
  これはその行を持つ、step record のディレクトリにあるファイルで、すべての行が record のあとのものなら、record の `evidence.http` はそれを名指しません。
  run サマリは、その数とそのファイルを step の行に挙げます。
  数えたリクエストには、どれも行があります。
  run(または `nuka do` の呼び出し)が終わるときにまだ開いているリクエストは、そのとき、`run.json` より前に書かれます。
  その行は `"status": 0` と `"error": "no response before the run ended, <n> ms after it was sent"` を持つか、届いた分の本文を持ちます。
  record を書いたあとのファイルの書き込み、socket、`runCommand` を通さずに起動したプロセスは、どこにも記録されません。
- 本文やファイルの中身はテキストとして `{ "text", "bytes" }` で残します。
  `text` が先頭だけを持つときは `"truncated": true` が加わります。
  バイト列が UTF-8 でなければ `"binary": true` が加わり、`text` はありません。
  nukadoko がまったく読まなかったとき(Playwright が自分でエンコードする multipart の本文、または step が `fetch` の `init` に渡した stream や FormData の本文で、`fetch` が送るものを変えなければ読めないもの)は `{ "unread": "<理由>" }` です。
  バイト列はデコードし、redact してから切り詰めます。
  そのため、切り詰めが分断するはずの secret はすでに置き換わっており、読んだ部分の終わりに残った secret の断片は捨てられます。
  `bytes` は、終わりまで読んだ本文か、サイズが分かる本文(文字列、バッファ、Blob)の、redact する前の全体のサイズです。
  nukadoko が自分の複製から読む `fetch` の本文(レスポンス、または Request のアップロード)は、最初の 32 KiB を 1 チャンク超えるところまでしか読まず、そこで手放します。
  そのため、どれだけ長い本文でも、記録のために step のプロセスが使うのはその分までで、step 自身の複製は自分のペースを保ちます。
  nukadoko がそこで読むのをやめた本文と、nukadoko が待つのをやめたとき(step の境界、または run の終わり)にまだ届いていた本文は、`bytes` の代わりに `"bytes_read"` を持ちます。
  これは nukadoko がやめる前に読んだバイト数で、全体のサイズではありません。
  そうした本文には必ず `"truncated": true` が付き、nukadoko が待つのをやめたときは `"incomplete": true` も付きます。
  nukadoko が起こしたのではないエラー、中断、終わる前の close で終わった本文(サーバが中断した、step がレスポンスを destroy した)は、`"bytes_read"` と、起きたことの最初の 1 行である `"error"` を持ちます。
  そうした本文は `incomplete` を持ちません。
  2 つはリクエストについて別のことを述べるからです。
  step の境界は、まだ届いているレスポンス本文を最大 1 秒待ち、届いた分を残します。
  event stream は終わらず、step record はそれを待たないからです。
  step が読み始めなかった `node:http` や `node:https` のレスポンス(`data` や `readable` のリスナーがなく、resume も pipe もされていない)は待ちません。
  その行は flush のときに `"response_body": { "unread": "the step did not read the body" }` を付けて書かれます。
  各行はリクエストが終わったときに追記されます。
  そのため、step がどれだけ多く送っても、終わったリクエストが step のプロセスに残すのはその数だけです。
  step が文字列として求めた本文(`setEncoding` のあと、またはエンコーディングを渡した書き込み)は、まずバイト列に戻すので、同じようにデコードし redact します。
- `evidence.http`(少なくとも 1 回の呼び出しが記録されたときだけ現れます)は http.jsonl を指します。
  1 行に 1 つの JSON オブジェクトで、形は `{ "method", "url", "status", "duration_ms", "via", "request_body", "response_body" }` です。
  `via` は、`request` fixture、または `page.request` か `context.request` を通した呼び出しなら `"request"` です。
  step 自身のコードがその API で送ったもの(`observed` を参照)なら `"fetch"`、`"node:http"`、`"node:https"` です。
  page 自身が行ったもの(`page` のナビゲーションや page 内の `fetch`/XHR)なら `"page"` です。
  どのエントリにも必ず付くため、読み手はその行がどの経路から来たかを形だけから推測せずに済みます。
  `"page"` 以外のどの行にも `"request_body"`(リクエストが何も送らなかったときはありません)と `"response_body"`(レスポンスが届かなかったか、HEAD、204、304、`content-length: 0` のように本文がなかったときは、どのクライアントでもありません)があり、それぞれ 16 KiB までのテキストとして残します(下記)。
  本文がない行は、ステータスの時点で書かれます。
  ヘッダは書きません。
  ヘッダは cookie と資格情報を運び、page のヘッダは trace が持つからです。
  page の行は本文を持ちません。
  page の通信は trace がすでに持つからです。
  step 自身が行った呼び出しは、結果にかかわらず記録されます。
  接続の拒否や、エラーステータスに対する `failOnStatusCode` のように、throw した呼び出しも含みます。
  `url` はレスポンスが返ってきた絶対 URL で、`params` が適用され、リダイレクトも辿られた後のものです。
  `via: "page"` のエントリと同じ形です。
  `declared_url` は step が渡した文字列で、`url` と異なるときだけ現れます。
  レスポンスが無いときは `status` が `0` になり、`error` に失敗メッセージの最初の 1 行が入ります。
  そのとき分かっている URL は宣言された文字列だけなので、それが `url` になります。
  `status` が `0` なら、必ず `error` があります。
  どのクライアントにも 1 つの規則が当てはまります。
  step の境界が待つのをやめたとき(最大 1 秒)にレスポンスがないリクエストは、そのときに `"error": "no response before the step ended, <n> ms after it was sent"` を付けて書かれ、あとで届いたレスポンスは何も変えません。
  `<n>` はそのリクエストに与えられた時間で、待つ間に step の残ったコードが送ったリクエストでは、境界が待った時間より短くなります。
  レスポンスもエラーもなく閉じたリクエストは `"error": "the request was closed before a response arrived"` を持ちます。
  送る前に throw する `fetch`(使用済みの Request、本文付きの GET)は、`fetch` が出すエラーを持つ行になり、step はそのエラーをそのまま受け取ります。
  `fetch` は step が渡した引数を、複製せずそのまま受け取ります。
  `init` は Request でも、メンバーがプロトタイプ上の getter であるオブジェクトでもよく、複製するとそれらが落ちるからです。
  Upgrade(WebSocket)や CONNECT は、ハンドシェイクの実際のステータス(101 またはトンネルのステータス)を持つ行で、CONNECT の `url` はその宛先の `<host>:<port>` です。
  接続がそのあとに運ぶものは `unmeasured` の socket になり、step の境界はそれを待ちません。
  追記の失敗で step が失敗することはありません。
  失敗は `http_log_failed`(下記)に数えられます。
  page のリクエストの行は、そのリクエストを送った step のものです。
  パスはリクエストが始まった時点で決まり、その step が返ったあとにレスポンスが届いても、そこへ追記されます。
  page の通信のうち http.jsonl に届くのは `document`、`xhr`、`fetch`(Playwright 自身の `request.resourceType()`)のリクエストだけです。
  実際のページ読み込みは画像やスタイルシート、スクリプトを何十件も引き込みますが、それを受け入れ確認の目的で読み手が 1 つずつ追うことはなく、そのすべてを保持しようとするファイルはそもそも読み手が開けるものではなくなってしまいます。
- `evidence.attachments`(空でないときだけ現れます)は、`evidence.attach`/`evidence.path` がこの実行で実際に書き込んだものを、`{ "name", "file", "at" }` の形でそれぞれ並べたものです(「Context API」を参照)。
  `name` は step が頼んだ名前、`file` は実際にディスクへ書かれたファイル名で、`evidence.dir` からの相対パスです。
  この 2 つが違うのは、同じ `name` がこの実行で 2 回以上使われたときだけです。
  大文字小文字だけが違う `name` も、ここでは同じ名前です。
  2 回目以降の使用には、拡張子の手前に `-2`、`-3`、... が挿入され、最初のファイルを上書きすることはありません(`dup.txt` の次は `dup-2.txt`、`Report.txt` の次は `report-2.txt` になり、1 つのファイルが黙って置き換わることはありません)。
  `at` は harness 自身が取得し、step が渡すことはありません。
  `attach` については書き込みが完了した時点、`path()` で払い出したファイルについては実行がその存在を確認した時点のそのファイル自身の mtime です。
  これは `sections`/`polls`/`evidence.screenshots[].at` がすでに従っている、計測であり宣言ではないという同じ規則であり、attachment を同じ絶対的なタイムラインに乗せます。
  `path()` を呼んだだけで、返されたパスに何も書かれなければ、エントリは 1 つも現れません。
  ディスク上に存在すると確認できたファイルだけが載るという、`evidence.http`/`evidence.trace` がすでに従っている「証跡は存在するファイルだけを指す」規則と同じです。
  `path()` で払い出したファイルが実際に書かれたかどうかは、harness が確認して決めるのであって、fixture 自身が呼び出しを覚えておいて決めるのではありません。
  パス区切りを含む、あるいは `.`/`..`/空文字列のいずれかと等しい `name` は、何も書き込む前に拒否され、黙って安全な形に書き換えられることはありません。
  `record.json`、`final.png`、`trace.zip`、`http.jsonl` と等しい `name`、有効な `pageAs` の名前についての `trace.<name>.zip` と `final.<name>.png` という形の `name`、そして `process-<n>.stdout.txt`、`process-<n>.stderr.txt`、`process-<n>.stdin.txt`、`process-<n>.json` という形の `name` も、同じように拒否されます(`ReservedEvidenceNameError`)。
  大文字小文字だけが違う綴りも拒否されます。
  それらは harness がこの directory に自分で書くファイルです。
  100 件で上限を設け、`at` で並べ替えます。
  `page_events`/`actions` と同じ規約です。
  その上限に達したときの真の総数は、下記の `truncated.evidence` に載ります。
  `truncated.actions` がすでに使っている、同じ兄弟フィールドです。
  step record の `name`/`file` という文字列は、他のどのフィールドとも同じ 1 回の redact を通ります。
  attachment 自身のファイルの *中身* は決して redact されません(任意のバイト列を redact すれば、保護するのと同じくらいの頻度で壊してしまうからです)。
  `attach` に渡すものを secret 抜きに保つのは、step 自身の責任です。
- `evidence.scratch`(空でないときだけ現れます)は、`scratch.dir`/`scratch.copy` がこの実行で作ったディレクトリの絶対パスを、作った順に並べたものです(「Context API」を参照)。
  ディレクトリは scenario が終わるときに削除されます。
  そのため、ここにあるパスは step が作業した場所を示すもので、まだ存在するファイルを示すものではありません。
- `http_omitted` は、少なくとも 1 件の page 由来のリクエストが省かれたときだけ現れます。
  省かれたものを数えることで、その省略を可視化します。
  http.jsonl に入らなかった分をリソースタイプ別に数えます。
  例えば `{ "image": 34, "stylesheet": 5, "script": 12 }` です。
- `http_log_failed`(数値)は、少なくとも 1 行の http.jsonl への追記に失敗したときだけ現れます。
  例えば step のディレクトリが無い、ディスクが満杯、権限が無い、といった場合です。
  失われた行の数を数えるので、step が送ったのに http.jsonl に無いリクエストが黙って消えることはありません。
  追記の失敗で step が失敗することはありません。
  計測が実行を壊してはならないからです。
- `used`(空でないときだけ現れます)は、この実行が値を引き出した以前の実行の一覧です。
  `from` による注入、`resultOf` の呼び出し、あるいは `nuka do` での `--use` の step record のいずれかを通じたものです。
  どの経路もライブラリのコードを通るため、読み取りは計測されるのであって宣言されるのではありません。
  各エントリは `{ "step_record_id": "step-…", "step": "create-project" }` の形です。
  step 名は引用元の step record と重複していますが、それでも書き留めます。
  読むために他のファイルと突き合わせなければならない record は、単独で読める record より読み手にとって劣ったものであり、突き合わせる相手になるファイルはローカルな作業記録にすぎず、retention がすでに消しているかもしれないからです。
  エントリは record id で重複排除され、最初に読まれた順に並びます。
  依存関係はこうして二重に可視になります: 静的には `from` か import として、実行時には step record 連鎖の provenance としてです。
  値がどの上流の *step* から来たかは、その step ファイルが書かれた時点ですでに決まっていました。
  そのどの *実行* が値を供給したかは、ここでしか分かりません。
- **失敗した** step record だけが、各 `used` エントリに `result` を追加します。
  id/step のすぐ隣に置かれる、上流の step record のバリデーション済みの result 全体です。
  これにより、step が実際に何を見たかを確かめるためだけに 2 つ目の `record.json` を開かなくても、失敗した step record 単体を読むだけで済みます。
  `passed` な step の `used` エントリが `result` を持つことは決してありません。
  重要だった値はすでにその step 自身の `result`(`from` 経由で入ってきた場合は `args`)に載っているため、そこで上流の値を繰り返しても冗長になるだけだからです。
  運ぶのは result 全体であり、`from` の注入や `resultOf` の呼び出しがたまたま読んだ 1 つのキーに絞り込まれることはありません。
  失敗を診断するのに必要なのは、どのキーが参照されたかではなく、上流の値が *なぜ* そうなったかだからです。
  参照されたキーに絞り込んでしまうと、step record 側で同じ罠を作り直すことになります。
  それは「後続の step が参照するものを返す」という、参照だけに頼る罠であり、「型付き step」ですでに戒められているものです。
  これはまた、このフィールドが運べるのは上流の step 自身の `returns` スキーマがそもそも保持していたものだけだということも意味します。
  値を落とす `returns` は、ここからもその値を落とします。
- `calls`(空でないときだけ現れます)は、この実行が `call` fixture を通じて実行した part を、呼び出しを開始した順に列挙したものです(「Parts」を参照)。
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
  `at`(ISO 8601。
  `section` が呼ばれた時点でコレクタ自身が取得し、step が渡すことはありません)は、すべてのラベルを、`started_at`/`finished_at`、`polls` 自身の `at`、`evidence.screenshots[].at` がすでに共有している同じ絶対的なタイムラインに乗せます。
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
  step は(`status: "passed"` のまま)裏で page がずっとエラーを投げていても pass することがあり、このフィールドが無かった頃は record にはそれを言うものが何もありませんでした。
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
  `trace`(step record の dir ではなく scenario 自身の directory からの相対パスです。
  hook には record dir 自体がありません)、`actions`、`truncated` は、上と全く同じ形で、全く同じ規則のもとで現れます。
  hook の呼び出しには `sections`/`polls` は並びません。
  どちらも typed step の `section`/`poll` fixture から来るものであり、hook はどちらを呼ぶための fixture bag も持たず、持つのは World(`this`)だけだからです。
  hook 自身が明示的に呼んだものではなく trace chunk 自体から読み出される `actions` は、この gap の影響を受けません。
  ブラウザに一度も触れなかった hook の呼び出しは chunk を開かず、この 3 つのフィールドのどれも運びません。
  `page` を一度も分割代入しなかった step と同じです。
- `fixtures`(空でないときだけ存在します)は、その step 自身の bag 解決が実際に触れた `config.fixtures` エントリすべてを列挙します。
  `{ "name", "scope", "setup_ms"?, "at"?, "reused" }` です(完全な形と、`setup_ms`/`at` が新しく構築されたエントリにしか存在しない理由は「Fixtures」を参照)。
  teardown 自体はこのリストに含まれません。
  teardown はこの step record がすでに閉じたあとに走るので、`scenario` scope の fixture 自身の teardown 失敗は scenario record の `teardown_errors` に載ります(「Fixtures」を参照)。
- `run.json` の `commit` は `{ "sha", "dirty" }` です。
  `sha` は run が始まったときに working tree があったコミットの 40 文字の完全な sha で、`dirty` はそのとき `git status --porcelain=v2 --branch`(untracked なファイルを含む)が `#` で始まるヘッダ行以外を出したかどうかです。
  pickle ごとではなく run の開始時に 1 回だけ計測するので、step が実行中に追跡対象のファイルを編集しても値は変わりません。
  git リポジトリの外、最初のコミットより前、git の呼び出しが失敗したときは `null` です。
  そのことで run 自体が失敗することはありません。
  run サマリがこれを報告するので(後述)、レビュアーはどのコミットが実行されたか、working tree に未コミットの変更があったかを見られます。
- run の step record は、その `run.json` の隣の `.nukadoko/runs/<run_id>/steps/<id>/` の下に、`nuka do` の step record は `.nukadoko/do/<id>/` の下に置かれます(「成果物」を参照)。
  どちらもローカルな作業上の計測であり、人が手元に残すのは pull request 上の run サマリです(後述)。

**run サマリ。**
record は機械とエージェントのために書かれます。
pickle を 1 つ以上実行した `nuka run` は、run 全体を 1 つにまとめた Markdown のサマリも書きます。
これは run をレビューする人のためのものです。
すべての record と run scope の hook の後に、run の `run.json` の文書だけから、1 つの純粋な関数で描画されます。
そのため `--concurrency` の run でも、worker ごとではなく親プロセスが 1 つのサマリを書きます。
サマリが `run.json` の言わないことを言うことはなく、CI のマシンからコピーした `run.json` からサマリを描画し直すこともできます。
中身は次のとおりです。

- 先頭の `<!-- nukadoko:run -->` という行。
  CI の step は、これで前に投稿した pull request のコメントを見つけて更新できます。
- run の断定と scenario の件数を載せた表題。
  断定は終了コードのものです。
  そのため、すべての scenario が green でも AfterAll が失敗すれば `failed` と読め、失敗がどの scenario の外で起きたかを述べる 1 文が付きます。
- 条件。
  短いコミット sha と未コミットの変更があったかどうか(`commit` から読み、無ければ unknown)、各 environment とその target version、scenario が起動したすべてのブラウザ(無ければ none launched)、`selection`(`partial` は、行の対象がそのファイルの他の scenario を外したことを言います)、nukadoko のバージョン、run id、開始と終了の時刻です。
- `--since` のときは「Criteria since `<ref>`」。
  unchanged、changed、new の scenario の数、消えた受け入れ基準の数(ambiguous か比べられなかったものがあればその数も)、比べた対象と step ファイル、変わった step ファイル、unchanged ではない各 scenario と消えた各受け入れ基準の行を `gherkin` のブロックで、そして変わった各 step ファイルの下にそれを名指すすべての scenario を載せます。
- feature ファイルごとの表(パス順)。
  scenario ごとに 1 行を行番号順に並べ、scenario、行、environment ごとに 1 列(列名は environment の名前)のセルの断定(`--repeat` のときは `<passed> of <n> passed`)、その行のすべての実行の所要時間を載せます。
  失敗した行には、どこで失敗したか(passed でも skipped でもない最初の step、それが無ければ最初に失敗した hook)、そのエラーの 1 行目、その step が読んだ step のうちプロセスが 0 以外で終わったものとその exit code と stderr の最初の行(stderr が空なら stdout の最初の行で、stderr と同じもの)、その step が `runCommand` で実行して 0 以外で終わった最後のコマンド、そして record のパスを載せます。
  これは失敗した environment ごとに 1 つずつ載り、run に environment が 2 つ以上あればその environment の名前が前に付きます。
- 「Unmeasured actions」。
  step がツールには見えたが計測できないこと(`observed.unmeasured`)をしたとき、または record を書いたあとにリクエストか `runCommand` のプロセスを始めたとき(`after_step_end`)、step ごとに 1 行を載せます。
  行は、その場所、テキスト、run に environment が 2 つ以上あればその environment、最大 3 つの操作と残りの数、始めたときは `started after the step ended: <n> request(s) in http.jsonl, <n> process(es)`、操作に `child_process` があれば `runCommand` でプロセスを起動するようにという助言、そして record のパスを持ちます。
  どちらもない step は何も加えず、`--repeat` のときは同じ行を持つ同じ step が 1 行になります。
- 「Findings」。
  失敗した scenario 以外の所見(書けなかったファイルや失敗した teardown などの警告)を run が出したとき、重大度、code、場所、メッセージを 1 件 1 行で載せます。
- 失敗した run では、失敗した各 scenario の `do` である `nuka run <feature>:<line>` コマンド。
  run に `--env` があれば、その scenario が失敗した environment を名指す `--env` も付きます。

サマリは毎回 `.nukadoko/runs/<run_id>/summary.md` に書かれます。
`$GITHUB_STEP_SUMMARY` が設定されていれば、それが指すファイルに追記されます(GitHub Actions はすべての step にこれを設定するので、設定なしでジョブのサマリページに run が載ります)。
終わった run であれば `nuka report --format markdown` が同じ本文を出し、`--out <path>` はそれをファイルに書きます。
書く先は、たとえば CI の step が pull request のコメントとして投稿するファイルです。
サマリの中のエラー文は `run.json` のものなので、secret はすでに伏せてあります。
書けなかったサマリは stderr の警告になり、終了コードを変えることはありません。
書けなかった `run.json` は、`run-result-not-written` の所見で run を失敗させ、その所見はサマリにも `--json` の文書にも載ります。
`run.json` はサマリを描く前に書くので、`run.json` を書けなかった run が passed と読まれることはありません。
後のコマンドはどれも `run.json` から run を読むので、それなしの緑の終了は、存在しない record を主張することになるからです。
書けなかった `sources.json` も、`run-sources-not-written` で同じように run を失敗させます。
それがないと、`nuka report` は run を描き出せないからです。
`sources.json` は最初に書くので、その所見はサマリにも、`run.json` にも、`--json` の文書にも載ります。
`run` の場所の行は、書けた `run.json` についてだけ出ます。
record を何も書かない setup の失敗は、サマリも書きません。

## Environment、secret

nukadoko は、Cucumber が提供しなかった実行インフラを提供します:

- **呼び出しをまたいで持ち運ばれる状態はありません。**
  `nuka run` の各 scenario も、`nuka do` の各呼び出しも、クリーンに始まります。
  ログイン状態が必要な step は、それを fixture から、またはその feature が名指す Given step から得ます。
- **Environment** はデプロイ先に名前を付けます。
  各 environment は `baseURL`、`envFiles`、`policy: "read-only"`、任意の `version` プローブを定義できます。
  read-only policy は mutate する step を拒否します。
  各 step record はプローブの結果を `target_version` として保存します。
  run サマリは各 environment と version を述べるので、レビュアーは run が green だったデプロイ先を知ります。
- **Secret**。
  git が分類するのは「出自」です。
  git が追跡していない env file(ignore されているか untracked。
  この 2 つは区別されません)は secret の源です。
  そこで定義される値はすべて secret であり、宣言は不要です。
  追跡されている env file は、working tree が HEAD と一致するときだけただの設定です。
  一致しているとき、その値はコミットされたものであり、nukadoko も secret であるふりをしません。
  コミットされていない変更(index に載っているものも含む)があるファイルは secret の源です。
  ディスク上の値は、コミットされた値ではないからです。
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
  読み込んだ値は、次のどの綴りで現れても、同じ `{{secret.NAME}}` に置き換わります。
  綴りは、値そのもの、`encodeURIComponent` が返すパーセントエンコードされた形、その形の `'` をそれぞれ `%27` にしたもの、`URLSearchParams` が返す `application/x-www-form-urlencoded` の形、そして `JSON.stringify` が文字列の中に書く JSON エスケープされた形です。
  `JSON.stringify` が足す引用符は、その形に含みません。
  URL の href は `%27` の綴りを使い、空白は `%20` のままです。
  `URLSearchParams` は空白を `+` と書き、`encodeURIComponent` がそのまま残す `!`、`'`、`(`、`)`、`~` をパーセントエンコードします。
  そのため、ログに残る前にこれらのどれかでエンコードされたクエリ文字列からも secret は消え、引用符やバックスラッシュがエスケープ済みの JSON テキストからも消えます。
  その形が、いずれかのキーの読み込んだ値そのものでもあるときは、そのキーの名前を使います。
  同じ値を共有するキーが複数あるときは、名前の辞書順で先の方です。
  どのキーも読み込んだ値そのものとしては持っていないパーセントエンコードされた形、`application/x-www-form-urlencoded` の形、JSON エスケープされた形は、その形を生むキーのうち辞書順で先のものの名前を使います。
  長い形から先に置き換えるので、短い secret が長い secret の一部だけを置き換えて壊すことはありません。
  数値の secret と数として等しい JSON の数値は、数値のまま残します。
  それを置き換えると、読み込んだ値とたまたま一致した件数や所要時間まで書き換わり、そのフィールドの型も変わってしまうからです。
  その数字の並びは、テキストとして現れた場所ではこれまで通り消えます。
  正直な限界もあります。
  4 文字未満の値は、どの形でも決して redact されません(この下限は `redact` で名指しされた値にも、他の secret とまったく同じように適用されます)。
  redact できるのは nukadoko 自身が読み込んだ値だけです。
  step の result の中で新たに生まれた token は捕まりません。
  そして `secrets.redact` に名指しされていない、HEAD と一致する追跡済みの値は、それらの面のすべてに平文のまま届きます。
  エージェント自身の会話ログも含めてです。
  その会話ログは、`.gitignore` の追跡/未追跡という線が引かれた時代にはまだ存在しておらず、「すでにリポジトリにある」がその会話ログについての判断だったことは一度もありません。
  Trace とスクリーンショットは redact されません。
  state directory は機密性の高いものです。
  `nuka check` はキーの値を決して報告しません。
  出す warning は 2 つです。
  1 つ目の `secrets-redact-key-too-short` は、`secrets.redact` が、値が短すぎて実際には redact されないキーを名指ししている場合です。
  2 つ目の `tracked-secret-looking-key` は、HEAD と一致する追跡済みの env file についてだけ、キーの「名前」が secret を保持しているように見えるのに `secrets.redact` に名指しされていない場合です。
  名前が secret に見えるのは、`SECRET`、`PASSWORD`、`TOKEN`、`CREDENTIAL` のいずれかを含む場合と、`KEY` がアンダースコアで区切られた 1 つの語として現れる場合です(`KEY`、`API_KEY`、`KEY_ID`、`PUBLIC_KEY_URL`)。
  `KEYWORD`、`MAX_KEYS_PER_PAGE`、`APIKEY` のように、文字が含まれているだけの名前は secret に見えるとは扱いません。
  この検査は名前パターンによるヒューリスティクスであり、使い道はただ 1 つ、warning を出すかどうかを決めることだけです。
  それが redact を決めることは決してありません。
  名前が secret に「見える」ことは、実際に redact されるものを増やしはしません。
  それを決めるのは git の分類(未追跡、ignore、HEAD と異なる追跡済みファイル、HEAD と一致する追跡済みファイル)と `secrets.redact` だけです。
  `nuka check` は、残りの 2 つの指摘も警告として報告します。
  `secrets-public-key-unknown` と `secrets-redact-key-unknown` は、`secrets.public` または `secrets.redact` が、設定されたどの envFile にも定義されていないキーを名指ししている場合です。

Configuration は `nukadoko.config.ts` にあり、`defineConfig` を使います。
次の表は、受け付ける各キーを示します。
詳細があるキーは、後の段落か、その機能を説明する節を指します。
nukadoko が読むのは、そのファイルの default export です。
default export が無いファイル、または default export が Promise であるファイルは、そのファイルを名指す `ConfigError` で拒否されます。
名前付き export は config ではありません。
読み込まれるのはオブジェクトそのもので、`export default defineConfig({ ... })` もその形です。
ファイルは `nuka` を実行したディレクトリから読み、親ディレクトリからは読みません。
`nukadoko.config.ts` も `nukadoko.config.mts` も無い場所では、config を読むコマンドはすべて、そのディレクトリと適用される既定値を示す 1 行を stderr に書きます。
`.git` を持つ最も近いディレクトリまでの親ディレクトリに config があるときは、その行はそのファイルも現在のディレクトリからの相対パスで示し、`nuka scaffold` は書き込みを拒否します。
そこに書いた step ファイルは、その config が読むものではないからです。
`nuka init` はファイルを書くので、この行は出しません。
`export default {}` は空の config で、ファイルが無いときと同じ既定値が入ります:

| キー | 内容 |
| --- | --- |
| `featuresDir` | feature ファイルと step のコード。`nuka run` が無人で実行する集合そのもの(デフォルトは `features`。Cucumber 流のやり方) |
| `additionalFeatureDirs` | `nuka check` が語彙を結び付ける対象を広げる追加のディレクトリ。`featuresDir` そのものを広げることはない(デフォルトは `[]`。下記) |
| `baseURL` | トップレベルの base URL。environment ごとに上書きされる(下記) |
| `envFiles` | トップレベルの env file。environment ごとに追記される(下記) |
| `environments` | environment ごとの `baseURL`、`envFiles`、`policy`、`version` プローブ(下記) |
| `stateDir` | nukadoko が実行時に書き込む場所(デフォルトは `.nukadoko`。「State directory」を参照) |
| `retention` | Measurement を残す長さ。`runs`(既定 20)は丸ごと残す最新の run の数、`adHocDays`(既定 7)はどの run にも属さない record の日数(「成果物」を参照) |
| `browserType` | `page` fixture が起動する Playwright のエンジン: `chromium`(デフォルト)、`firefox`、`webkit`(下記) |
| `browser` | Playwright 自身の `LaunchOptions`。そのエンジンの `launch` にそのまま渡される(下記) |
| `browserContext` | Playwright 自身の `BrowserContextOptions`。`browser.newContext()` に渡される(下記) |
| `requestContext` | `request` fixture に対応する `newContext` のオプション(下記) |
| `secrets` | `public`/`redact` のリスト。キーごとの redact の扱いを調整する(上記) |
| `parameterTypes` | カスタムの cucumber-expressions parameter type(下記) |
| `worldParameters` | compat の World が `parameters` として受け取るオブジェクト(デフォルトは `{}`。下記) |
| `fixtures` | ユーザー定義の fixture(「Fixtures」を参照) |
| `fixtureTimeout` | fixture インスタンスごとの setup/teardown の既定タイムアウト(ms)(「Fixtures」を参照) |
| `stepTimeout` | typed step 自身の `run` に許す時間(ms、既定 1,200,000。`defineStep({ timeout })` が上書きし、compat step は対象外) |

`additionalFeatureDirs`(デフォルトは `[]`)は、`featuresDir` とは違う問いに答えます。
`featuresDir` は無人で *実行される* 集合です。
引数なしの `nuka run` はちょうどそのディレクトリだけを反復し、このキーがそれを広げることは決してありません。
`featuresDir` と `additionalFeatureDirs` を合わせたものが、静的チェックが語彙を *結び付ける* 対象となる集合です。
引数なしの `nuka check` はこの広い集合を歩きます。
ある step の pattern が結び付けられているかどうかはプロジェクト全体の性質であり、今日の無人の run が何を実行するかの性質ではないからです。
だからこそ、取り込み済みの変更のための feature(「レビュー」を参照)は、`featuresDir` の外に留まる限り `additionalFeatureDirs` に属します。
`additionalFeatureDirs` にそのディレクトリを名指しすれば、その feature が結び付ける step は `pattern-unbound` として報告される代わりに結び付けられていると数えられ、それでいてなお無人では実行されません。
プロダクト自身の中核の経路を述べる feature は `featuresDir` へ移り、ここへのエントリは要りません。
ディスク上に存在しないエントリは config の誤りであり、空のスキャン結果として素通りさせてよいものではありません。
`nuka check` はそれをエラー(`additional-feature-dir-missing`)として報告します。

この feature の走査は、`featuresDir` でも、各 `additionalFeatureDirs` エントリでも、`nuka run` に渡したディレクトリでも、どの深さでも `node_modules` と `.` で始まるディレクトリをスキップします。
step discovery も同じディレクトリをスキップします。
その中にある `.feature` ファイルは `nuka check` にも `nuka run` にも含まれず、このスキップは何も報告しません。

`browserType` は `page` fixture が起動する Playwright のエンジンを選びます: `"chromium"`(デフォルト)、`"firefox"`、`"webkit"` のいずれかです。
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
`run.json` の scenario 自身の `browser` フィールド(「実行」を参照)には、run が実際に起動したエンジンとバージョンが、同じように計測されて載ります。

`browser` は Playwright 自身の `LaunchOptions` 型をそのまま受け取ります。
zod は「これがオブジェクトかどうか」以上には形を再検証しません。
型は `defineConfig` から来るため、`tsc` は `nukadoko.config.ts` の他の場所と同じやり方で typo を捕まえます。
Playwright のオプションを zod で列挙し直すと、Playwright が 1 つ追加するたびに追随が必要になり、その追随が追いつくまでのあいだ、config を書く人は本当は使える Playwright のオプションを使えなくなってしまいます。
`browser` は、選ばれたエンジン自身の `launch` にそのまま渡されます(どのエンジンかを選ぶのは上記の `browserType` です)。
省略した場合は Playwright 自身の既定値(`headless: true`)が適用されます。
`newContext` の `viewport` のようなオプションは別の Playwright の型であり、この `browser` キーでは受け付けません(下記の `browserContext`/`requestContext` を参照)。

`browserContext` と `requestContext` は、`browser` の `launch` に対応する `newContext` 側のキーです。
`browser.newContext()`(step の bag が `page` を名指すと構築されます)と `playwrightRequest.newContext()`(step の bag が `request` を名指すと構築されます)は別々の Playwright 呼び出しであり、オプションの型も別々なので、1 つの共有キーではなくそれぞれに専用のキーを用意しています。
これは `browser` が従っているのと同じ「Playwright 自身の型に委ねる」方針です。
これにより `ignoreHTTPSErrors` のようなオプションに初めて手が届くようになります。
自己署名証明書を使うローカルの接続先では、どちらの fixture にもそれを設定する手段がこれまでありませんでした。
どちらのキーも `baseURL` は理由を述べたエラーで拒否し、黙って無視することはしません。
`config.baseURL` はプロジェクトの base URL の唯一の出所であり、2 つ目の出所があると config が食い違う値を持ちうるからです。
`storageState` はそのまま Playwright に渡ります。
ログイン状態のファイルを持つプロジェクトは、ここでそれを名指します。

`parameterTypes` のエントリは、カスタムの cucumber-expressions parameter type を登録します(`{ name, regexp, transformer? }`)。
たとえば `{ name: "negation", regexp: /( not)?/, transformer: (s) => s === " not" }` は、`will{negated:negation} return` という pattern を素の `z.boolean()` の args キーに結び付けられるようにします。
登録が config に住むのは、config が既に実行可能な TypeScript だからです(version probe が関数である理由と同じです)。
nukadoko には登録を置くための support ファイルという形式がありません。
名前は組み込み型と衝突してはなりません。
`{int}` の意味をプロジェクトごとに再定義できてしまうと、それを使うすべての pattern の意味が静かに変わってしまうからです。
transformer は型強制です。
その `this` はその scenario の World であり、返した Promise は step が走る前に await されます。
契約であり続けるのは args のスキーマです。

`worldParameters` は、compat の World のコンストラクタが `parameters` として受け取るオブジェクトであり、glue はそれを `this.parameters` として読みます。
cucumber-js は同じオブジェクトを自分の設定か `--world-parameters` から取っていました。
デフォルトは `{}` です。
設定する場所は config だけです。
キーの横にコマンドラインのフラグを置くと、1 つのオブジェクトに出所が 2 つでき、両者が食い違うことがあります。
値はプレーンなオブジェクトでなければなりません。
配列、文字列、`null` は config のエラーであり、step が欠落として読んでしまう空のオブジェクトにはなりません。

environment のエントリは `{ baseURL?, envFiles?, policy?: "read-only", version?: () => string | Promise<string> }` です。
その `baseURL` はトップレベルのものを上書きし、その `envFiles` はトップレベルのリストのあとに追加されます(あとのファイルが勝ちます。
dotenv のユーザーにはおなじみの、共通設定と上書きの重ね方です)。
ディスク上にないパスは、何も寄与しません。
`nuka check` は `env-file-missing` で警告し、environment 自身のリストにあるパスは `environment-env-file-missing` で警告します。
存在しているが読めないパス、またはそのパスにあるディレクトリは、setup を止めます。
拒否は `env-file-unreadable` で、`nuka check`、`nuka run`（`--no-check` の有無を問わず）、`nuka do` のどれでも exit 2 です。
拒否は、設定されたパスと errno を名指しします。
同じ読み取りが `env` fixture と secret の集合の両方を埋めるので、ファイルがロードされたかどうかは両者で一致します。
`policy` と `version` は environment ごとにしか存在しません。
`--env` を指定しないことは名前 `default` を意味し、これはエントリを必要としません。
それでも `default` という名前のエントリは書けます。
そこに `policy: "read-only"` を置くことが、`--env` 無しで打った `nuka do` をどこにも書き込ませない手段です。
明示的に名前を付けた environment は存在していなければなりません。
名前を付けるということは、それが存在すると主張することだからです。
`version` プローブが関数になっているのは、config がすでに実行可能な TypeScript だからです(URL と jsonPath の DSL は `fetch` を書くにはより悪い方法でしょう)。
ツールはこれを実行ごとに 1 回、10 秒の予算で呼び出し、throw やタイムアウトが犠牲にするのは `target_version` だけで、実行そのものが失敗することはありません。

env file は `KEY=VALUE` のテキストです。
`env` fixture と secret set は、同じパーサでこれを読みます。
コメント、引用符、バックスラッシュのエスケープ、複数行にまたがる値は、dotenv のデフォルトのパーサに従います。
区切りは `=` だけです。
`:` は区切りではありません。
改行は LF、CRLF、または単独の CR です。
値が複数行にまたがるとき、ファイルがどの改行を使っていても、値の中の改行は LF です。
空行は無視します。
空白以外の最初の文字が `#` の行はコメントです。
`export` のあとに空白が続くとき、それは省略できる接頭辞です。
最初の `=` がキーと値を分け、その前後の空白は除きます。
キーは、その `=` より前に残った文字列であり、空ではいけません。
ASCII の英字に限りません。
同じキーのあとの行は、前の行を置き換えます。
`$NAME` は展開しません。
引用符で囲まない値は、行末か `#` までです。
その `#` は、直前に空白がなくてもコメントの開始です。
値の前後の空白は除き、値の中に `=` があっても構いません。
二重引用符、一重引用符、バッククォートの値は、複数行にまたがれます。
閉じる引用符の直前のバックスラッシュは、その引用符を値の中に残します。
閉じたあとの行末までは、空白か `#` のコメントだけです。
それ以外が続くときは、引用符を含めて、引用符で囲まないテキストとして読みます。
二重引用符の中では、`\n` は改行になり、`\r` は復帰になります。
その直前のバックスラッシュは特別ではないので、`\\n` はバックスラッシュと改行です。
一重引用符とバッククォートは、エスケープを展開しません。
閉じない引用符は、その行の普通の文字であり、引用符そのものも値に残ります。
次の行は、別の行として読みます。
空行でもコメントでもなく、代入の一部でもない行は、読み飛ばします。
`nuka check` は、それを warning の `env-file-skipped-line` として報告します。
報告が名指しするのはファイルと行番号であり、行のテキストではありません。
そのテキストは secret かもしれないからです。
実行は、読めた代入をそのまま読み込みます。

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
データは measurement と export の 2 種類に分かれます(「成果物」を参照):

- `runs/<run_id>/`(`nuka run` の呼び出しごとに 1 つのディレクトリ)。
  その run が計測したものをすべて持ちます。
  CI は run ごとに 1 つのディレクトリをアップロードし、retention と `clean` は 1 つのディレクトリを消します(「成果物」を参照)。
  - run の結果である `run.json` と、run サマリである `summary.md`(「Records」を参照)。
    そして、run が parse したすべての feature ファイルの本文である `sources.json`。
    これがあるので、`nuka report` はこのディレクトリだけから run を描き出せます
  - `steps/<id>/`(step record ごとに 1 つのディレクトリ: record の JSON とその evidence ファイル(trace.zip、screenshots、http.jsonl))
  - `scenarios/<id>/`(自分の evidence を書いた scenario の実行ごとに 1 つのディレクトリ: scenario 自身の最終スクリーンショット、そしてブラウザに触れた Before/After/AfterStep フックの呼び出しごとの trace chunk)。
    各呼び出しに一意な名前が付きます(例えば `hook-before-0.zip`、`hook-after_step-1-2.zip`)。
    複数の hook がこの 1 つのディレクトリを共有しうるからです。
    自分自身の `steps/<id>/` を決して共有しない step とは違います。
    これは Playwright 自身のテストごとの `test-results/` という規約を 1 階層上でなぞったものです。
    scenario 全体をまたぐ trace.zip はここにはありません。
    各 step 自身の trace は、その step 自身の `steps/<id>/` の下に置かれます(「実行」を参照)。
    これらを何も書かなかった scenario はディレクトリを残しません。
    `run.json` の中のそのエントリが、その record です。
  - `exports` は、`nuka report` がその run について state directory の下に書いたすべてのファイル(Allure の result、container、attachment、そして `--out` でそこへ書いた messages ストリームやサマリ)を、ルートからの相対パスで 1 行に 1 つ列挙したものです。
    これがあるので、run の export 出力は run と一緒に消え、同じ run を描き直すときに置き換えられます。
    状態や時刻は持ちません。
    それは `run.json` が持ちます。
- `do/<id>/`(`nuka do` の step record ごとに 1 つの、run の `steps/<id>/` と同じ形のディレクトリ)。
  `nuka do` の呼び出しはどの run にも属さないので、その record はどの run ディレクトリからも離れて置かれます。
- `export/allure-results/`(`nuka report --format allure` の既定の書き込み先。
  持つのは多くても `runs/` が持つ run までです。
  run のファイルは run と一緒に消えるからです(「成果物」を参照)。
  新しい Allure launch が欲しければ削除してよい)。
  `init --allure` もこれを空のまま作ります。
  Allure 自身の CLI は、存在しないディレクトリでは起動を拒む一方、空のディレクトリなら受け付けるからです。
  これにより、最初に描き出すより前から `allure watch` を起動しておけます。

日常の削除は retention で、`nuka run` 自身が毎回の run の終わりに適用します(「成果物」を参照)。
`nuka clean [--dry-run] [--json]` は、2 種類を一度に消すコマンドです。
すべての run ディレクトリ、すべての `do/` の record、run の exports manifest が名指す `export/` の下のファイル、そして `export/allure-results/` の中身を消します。
`export/` のそれ以外の entry は残ります。
Allure の history ファイル、`allure generate` のレポート、人が置いたファイルなどです。
nukadoko が消すのは、自分が書いたものだけです。
run がファイルの一覧を残すようになる前に書かれた `allure-results/` を消すのもこのコマンドです。
retention はそこに決して触れません。
以前のリリースが state directory の下に書き、今は何も読まない `cache/` と `records/` のディレクトリも、一覧に出して消します。
`cache/sessions/` は、各 session のブラウザの storage state を、cookie も含めて持っていました。
`--json` の計画は、それらを `legacy` に挙げます。
state directory の外へ `--out` で書いたレポートは呼び出し側のファイルであり、`nuka clean` は読みも消しもしません。
あった results ディレクトリは空の状態で作り直すので、そこを指す `allure watch` は見失いません。
空の results ディレクトリは一覧に出さないので、clean の直後の clean は `ok: nothing to clean` を出します。
なかった results ディレクトリは作りません。
カテゴリを問わず決して触れないファイルが 1 つあります。
`export/allure-history.jsonl` は `export/allure-results/` の隣にあり、その中にはなく、`.nukadoko/` の下にある成果物の中で唯一、再実行では作り直せないものです。

リポジトリには、feature ファイルと型付き step という耐久性のある成果物を置きます。

## レビュー

変更が受け入れ基準を満たすかどうかは人が決めます。
nukadoko はその人に 2 つの読み物を渡します。
feature ファイルと run サマリです(「Records」の run サマリの説明を参照)。
feature は、何が合意されたかをレビュアー自身の言葉で述べます。
run はその証跡であり、サマリはその証跡を述べます。
これらの scenario がこのコミットで、この条件のもとで、この計測とともに走ったこと、そして `nuka run --since <ref>` のもとでは、承認された基点から、どの受け入れ基準が変わり、増え、消えたか、そしてその step の背後のどのファイルが変わったかです。
それは「実行」の比較が届く範囲のことです。
nukadoko が述べるのはこの主張だけです。
誰が承認するかは決めず、承認も記録しません。
承認をどこに記録するかはチームのプロセスで、nukadoko の外にあります。
pull request のレビューも、変更チケットも、監査ログも、サマリが名指すコミットと run id でその run を指せます。
後の変更は、自分の「Criteria since」の節を持つ新しい run として現れます。

green の run は「この scenario はコミット X で通った」という過去形の主張です。
サマリもそのように述べます。
コミット、working tree に未コミットの変更があったかどうか、environment、ブラウザ、時刻です。
そのコミットより後のソフトウェアについては何も主張しません。
この範囲の取り方が、要求のトレーサビリティマトリクスの劣化を防ぎます。
マトリクスは現在のシステムを記述すると主張するので、変更のたびにずれていきます。

チケットへのリンク欄も要りません。
tag と `Feature:` の下の自由な説明文が、チケットの id、その URL、レビュアー自身の言葉による基準を運び、差分がそのすべてを見せます。
nukadoko にはチケットという概念がありません。
計画のサブシステムや推論の欄もありません。
feature ファイルと、それに結び付いた型付き step が、何が基準を証明するかに答えます。
scenario が基準を表しているかどうかは、レビュアーが pull request のレビューの中で判断します。

変更が取り込まれた後、プロジェクトは feature の今後の役割を選びます。
ほとんどの受け入れ基準は、依頼された変更を記述します。
その変更が取り込まれれば、もう一度実行しても確かめる主張は残っていません。
そうした feature は `featuresDir` の外に置いたまま `additionalFeatureDirs` に列挙できます(「Environment、secret」を参照)。
すると静的チェックはその step を結び付け続け、無人では何も実行しません。
削除してもかまいません。
製品を通る持続的な経路を記述する scenario もあります。
そうした feature は `featuresDir` に移り、`nuka run` は以後のすべてのコミットでそれを選びます。

### 受け入れループ

agent は、チケットの受け入れ基準に対して次の手順を実行します。

1. 語彙を読みます(`nuka steps --json`、そして関連しそうなものの契約については `nuka describe <step>`)。
2. 操作が欠けているときは `nuka scaffold <name>` し、それを実装し、step record が正しく見えるまで `nuka do` で単体で動かします。
   feature を先に書いたときは、`nuka scaffold --feature <file>` が、step が一致しない行ごとに stub を 1 つ書きます。
3. feature を書きます。
   tag と `Feature:` の下の説明文が、チケットの id とレビュアーの言葉による基準を運びます。
   scenario は、その基準を語彙に翻訳したものです。
4. 何かが実行される前に、`nuka check <feature>` を行います(未定義の step、pattern と schema の不一致、mutate する step に結び付いた Then)。
   feature が置かれているディレクトリが `additionalFeatureDirs` に列挙されていない限り、パスを渡します。
   引数なしの `nuka check` は `featuresDir` とそのリストを歩くため、`featuresDir` の外に意図的に置かれ、どこにも名指しされていない feature こそが、まさにそれが届かない対象だからです。
5. green になるまで `nuka run <feature>` します。
   デバッグ中は `<feature>:<line>` の run でかまいません。
   その run サマリは選んだ scenario しか扱いません。
6. pull request などで、変更をレビューに出します。
   CI が feature を実行し、run サマリをその横に公開します(`docs/ci.ja.md` を参照)。
   `--since <base>` には、最後に承認された基点を名指します。
7. 人が feature とサマリを読みます。
   run が証跡です。
   その人が承認をどこに記録するかは、チームのプロセスです。

手順 1 から 4 に作業があります。
新しい型付き step と feature は通常のレビューの題材です。
手順 5 と 6 は機械的です。
手順 7 は、nukadoko が人に残す 1 つの判断です。
scenario がチケットの求めたことを述べているか、そしてサマリが記述する run が数えるべき run かどうかです。

このループは受け入れ基準から始まります。
探索はこのループの手順 3 で合流します。
`nuka do` の一連の呼び出しを実行した agent は、各 step とその args を知っているので、keyword と主張も含めて scenario を書きます。
そのあと `nuka check` が、何かを実行する前に、各行を語彙に照らして読み戻します。

## Allure results

`nuka report --format allure` は、終わった 1 つの run について、scenario の実行ごとに 1 つの Allure test result を書きます。
読むのは run ディレクトリだけです。
run.json、step record、そして run が parse した feature の本文である `sources.json` です。
そのため CI のマシンから持ち出した run ディレクトリも、それを実行したプロジェクトにある run ディレクトリと同じ result を描き出します。
そうしたディレクトリは信頼できない入力なので、record が名指すパスはどれも、symlink も含めて解決し、run ディレクトリの中にとどまるときだけ読みます。
このプロジェクト自身の run でも、読める範囲は広がりません。
state ディレクトリへコピーしたディレクトリも自身の run として扱われるからで、`nuka run` が記録するファイルはどれも run ディレクトリの中にあります。
report が自分で開くファイル（run.json、`sources.json`、各 step の `record.json`、run の exports manifest）も、実パスで同じ規則に従うので、その中の symlink をたどって外へ出ることはありません。
`<stateDir>/runs/` の下の run ディレクトリが symlink であれば、`run-invalid` で拒否します。
ここまでの確認はどれも run ディレクトリを基点にしているからです。
`runs/` の外のパスで名指した run ディレクトリは呼び出し側の選択であり、その実体が基点になります。
外へ出るパスは読まず、`report-incomplete` の finding になり、そのファイルが result にも messages ストリームにも入ることはありません。
report は `run_id` をパスへつなぐので、`nuka run` が生成する 1 つのパス要素（`run-YYYYMMDD-HHMMSS-xxxx`）でない `run_id` を持つ run.json は `run-invalid` で拒否します。
3 つの形式のどれかが読むフィールドが欠けている、null である、あるいは別の型である run.json も、同じく `run-invalid` で拒否します。
この検査は 3 つの形式が読むものすべてを覆うので、どの形式も推測で読むフィールドに出会いません。
result は Allure 2 のファイル形式を使い、Allure 2 と Allure 3 の両方が読めます。
nukadoko は HTML をレンダリングしません。

`nuka run` は Allure の result を書きません。
nukadoko を単体テストの隣で走らせるプロジェクトの多くは Allure のレポートを読まず、それでも書いていた run は、誰も読まない export ファイルを十数個残していました。
run の後に描き出せば、1 つの run を別の形式や別のディレクトリへ、何も実行し直さずに描き直すこともできます。

result の出力先は `.nukadoko/export/allure-results/`、または `--out` が名指すディレクトリです。
相対の `--out` はプロジェクトの root を基準に解決し、絶対パスはそのまま使います。
`--out` までの途中にないディレクトリは、呼び出し側がそのパスを名指したので作ります。
それ以外のものが行く手にあれば、run を読む前に `report-out-invalid` で拒否します。
Markdown や messages がファイルを書く場所にあるディレクトリ、Allure がディレクトリを書く場所にあるファイル、FIFO などの特殊なファイル、リンク先のないシンボリックリンク、通常のファイルの下のパスです。
export ディレクトリの `allure-history.jsonl` も、大文字小文字を問わず、そのディレクトリへのリンク越しでも拒否します。
その上に描き出すと、履歴が失われて戻らないからです。
markdown や messages のファイルをファイルシステムが書き込ませないとき（読み取り専用のディレクトリの下、`/proc` の下）も、同じコードで、返されたエラーコード（`ENOENT` や `EACCES` など）を添えて拒否します。
Allure のディレクトリにファイルシステムが書き込ませないときは、結果を 1 ファイルずつ書くため `report-incomplete` になります。
拒否は `--out` の値を入力されたとおりに名指し、`--out` がなければ既定の Allure ディレクトリを名指します。
run ディレクトリを渡さない `nuka report` は最新の run を描き出し、run ディレクトリを引数に渡せばその run を描き出します。
その run がこのプロジェクトの run であれば、`<stateDir>/export/` の下に書いた各ファイルはその run の exports manifest に記され、retention が run と一緒に消します。
同じ run を同じディレクトリへ描き直すと、前回その run を描き出したときにそこへ書いたファイルと、manifest のその行を先に消すため、ディレクトリには各 scenario が 1 つずつ残り、manifest は各ファイルを 1 度だけ名指します。
result、container、attachment の名前は、ランダムではなく run id、scenario record、environment から決まります。
そのため、同じ run の 2 回目の描き出しは、どこへ書いても 1 回目を上書きします。
state ディレクトリの外の `--out` のディレクトリでも、既定のディレクトリへ描き出したコピーの run でも同じです。
別の run を描き出すと、その result はほかの result の隣に加わります。
2 つの run を 1 つの Allure launch とみなすか 2 つとみなすかは、呼び出し側が決めます。
`nuka clean` は `.nukadoko/export/allure-results/` を空にし、state directory の外へ `--out` で書いたディレクトリを消すのは呼び出し側です。
`categories.json` と `environment.properties` は、描き出すたびに書かれます。
`nuka init --allure` は既定のディレクトリを作るため、最初に描き出すより前に `allure watch` を開始できます。

描き出しは、読めたものを書き、書かなかったものを名指します。
読めなかった、対応づけられなかった、書けなかった scenario、step record、attachment は、どれも severity が `failed` の `report-incomplete` の finding になり、report は 1 で終了します。
そのため、それを公開するスクリプトが run の全体だと取り違えることはありません。
attachment が 1 つ欠けても、失うのはその attachment だけで、result の残りは書かれます。
run が書いた step record がディレクトリにもうない step は `broken` になり、その record と run.json がその step に与えた状態を名指すメッセージを持ちます。
そうした step を含む passed の scenario も `broken` になります。
詳細のない passed の result は、完全なものに見えてしまうからです。
messages ストリームでは、同じ step は `UNKNOWN` です。
`nuka report` がディレクトリの隣に出す数は、書いた result の数です。

各 result は pickle の名前を使い、Gherkin の step を `steps[]` に格納します。
step 名は Gherkin keyword と AST の空白を保ち、`And` も正規化しません。
各 step entry は status、時間、parameter、attachment、宣言された log、call、計測された子 timeline を保持します。

result は次の label と path を持ちます。

- `feature` label は Feature 名を持ちます。
- `package` label はプロジェクト名と feature の path をドットで区切って持ちます。
- pickle が継承した各 tag は、次の二つの形を除いて、`@` を保つ `tag` label になります。
  `@allure.label.<name>:<value>` という tag は、その値を持つ `<name>` label になります。
  `@allure.id:<value>` という tag は、その値を持つ `ALLURE_ID` label になります。
  どちらの形も `:` の代わりに `=` を受け付け、`tag` label にはなりません。
- scenario result は宣言されたすべての label と link を受け取ります。
- `titlePath` はプロジェクト名、feature のディレクトリ要素、Feature 名を持ちます。
- result は `parentSuite` と `suite` を未設定のままにします。
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
`nuka report` は TestOps の移行用フィールド `_fallbackTestCaseId` を書きません。

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
`nuka init --allure` は生成する `allurerc.mjs` にこれを無条件で書き込み、`.nukadoko/export/allure-history.jsonl` を指します。
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
`record.json` に後からフィールドが増えても、対応付けを変更しなくてもレポートに自動で届きます。
この節の他の場所で個別にマップされたフィールドもそのまま残ります。
1 つの事実を知りたいだけの読み手が attachment を開かなくて済むようにするためです。
`record.json` は、個別のマッピングが書かれていない場合でもレポートを完全に保つ、その受け皿です。

宣言された attachment には `declared:` を接頭辞に付けた名前が付きます。
すべてが同じ result ファイルに収まったとき、この接頭辞こそが provenance(nukadoko によって計測されたのか、step によって自己申告されたのか)の生き残る唯一の場所です。

宣言された log、計測された timeline entry、part の call は Gherkin step の下に子 step として現れます。

step entry は `sections`、`polls`、`actions` を 1 本のネストされた child step タイムラインにまとめます(「Records」を参照)。
それらは `at` の昇順でマージされます。
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
`ms` は child step 自身の幅としてすでに見えており、これは `page_events` の件数を step の名前に入れない理由と同じです。
`timeout_ms` は `record.json` という attachment の中にとどまります。
`actions` 自身が 100 件で打ち切られていたとき(「Records」の `truncated.actions` を参照)、タイムラインの末尾にもう 1 つ、幅ゼロで passed の child step が加わり、打ち切りの事実を名指しします(例: `... 4113 more actions not shown`)。
タイムラインだけを見た読み手が、打ち切られたリストを全部だと取り違えることが決してないようにするためです。
親 step entry 自身の start/stop の範囲にクランプすることは決してありません。
その範囲の外に出た timeline entry は実際に起きたことであり、隠せば読めなくなるだけで、起きなかったことにはなりません。

`page_events` は最大 3 つの parameter になります(「Records」を参照)。
parameter は `console errors (observed)`、`page errors (observed)`、`failed requests (observed)` です。
1 件以上の entry を持つ種類だけに parameter が加わるため、読み手は `record.json` を開かずに件数を確認できます。
収集側が打ち切った種類は、表示件数の隣に真の総数を示します(例えば `100 of 4213`)。
表示件数だけでは、実際に起きたことを過少に見せてしまいます。

step entry の parameter は、その宣言である `mutates (declared)` と、compat の step では World で読み書きしたもの `world reads (observed)` / `world writes (observed)` を運びます。
HTTP の書き込みを数える parameter はありません。
メソッドによる回数はプロキシであり、書き込みの計測ではないからです(「キーワードの意味論」を参照)。
step が送ったものと受け取ったものは、隣に添付された step record が持ちます。

失敗した scenario は `statusDetails.message` に `[nukadoko.failure=<kind>]` を入れます。
元の error message は `statusDetails.trace` に書きます。
marker は、失敗した step の step record(hook が scenario を止めた場合は、その hook 自身の record)がすでに持つ同じ `error.kind` を名指しし、同じ `error.kind` は `nukadoko.failure` という result label としても書き出されます。
2 つの Allure 世代は、それを別々の経路で category に変換し、利用者に求めるものも異なります。

- **Allure 2** には result ごとの category フィールドが無いため、`nuka report` は描き出すたびに `categories.json` も書きます。
  このファイルは `error.kind` ごとに 1 つ、合計 7 つの rule を持ち、メッセージの接頭辞を正規表現で照合します。
  メッセージの接頭辞と category rule は同じ分類を表すため、利用者は追加の設定を必要としません。
- **Allure 3** は `allure generate` または `allure report` の実行時に、results directory の `categories.json` を読みません。
  Allure 3 は category を config だけから取得し、result の label と照合します。
  `nukadoko.failure` がその label を供給します。
  `nuka init --allure` はプロジェクトの root に `allurerc.mjs` を書き出し、`error.kind` ごとに 1 つ、7 個の label-matcher rule を持たせます。
  この 7 個の名前は `NAME_BY_KIND`(`src/report/allure/categories.ts`)から組み立てられるため、result 自身が使う名前と決してずれません。
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
BeforeAll と AfterAll には result が対応できる run level の record がありません。
scenario record は hook ごとの timestamp を持たないため、hook の duration は scenario の境界を使います。

すべてのファイルは temp file の rename を通じて着地するため、`allure watch` のような読み手が書きかけの result を目にすることは決してありません。
run の result が現れるのは、run の後に `nuka report` がそれを描き出したときです。
進行中の run をライブで見るのは、`nuka run` が stderr に出す進捗の出力です。

ad-hoc な `nuka do` の record はダッシュボードの対象外です。
探索した内容は feature に記録し、`nuka run` がその scenario を実行して `nuka report` がその run を描き出した時点でレポートの対象になります。

各 run は Allure が表示し、nukadoko 自身には web UI がありません。
history、trend、flakiness も Allure の機能です。
上の identity の段落のとおり、この result はそれらを `historyPath` が設定されていれば scenario 粒度で供給し、step 粒度では決して供給しません。
後の呼び出しの step entry が今回の呼び出しに紐づくことは何もなく、紐づくのは scenario だけです。

未実装なのは、`@issue:123` などの tag に対する link-template の設定です。

要点はフォーマットの派閥争いではありません。
従来の cucumber の実行が Allure レポートを満たすのは、glue の作者が手で evidence を添付した箇所だけですが、nukadoko の harness はどのみちすべてを計測しており、Allure 自身のモデル(attachment、label、parameter)には、その全部の一級の置き場所が既にありました。
Allure の result は、nukadoko の計測の余剰が見えるようになる場所です。
下にある messages ストリームは 2 つ目の、より狭い出力であり、その役割は計測の余剰ではなく compat の忠実さです。

## Messages stream

`nuka report --format messages` は、終わった 1 つの run を、`@cucumber/messages` を通して 1 つの cucumber messages ストリームとして書きます。
1 行 1 envelope の NDJSON です。
出力先は stdout、または `--out` が名指すファイルです。
相対の `--out` はプロジェクトの root を基準に解決し、絶対パスはそのまま使います。
Allure の result と同じく、ストリームは run の後に run ディレクトリだけから描き出され、`nuka run` は何も書きません。
scenario 自身のスクリーンショットと各 hook の trace はストリームに envelope がないので読みませんが、そのうち run ディレクトリの外へ出るパスは、Allure の result と同じく `report-incomplete` の finding になります。
このプロジェクト自身の run について `<stateDir>/export/` の下に書いたファイルは、その run の exports manifest に記されるので、retention と `nuka clean` が run と一緒に消します。

- 1 回の描き出しは、1 つの run の 1 つのストリームです。
  2 つの run がストリームを共有することはなく、書き終えたストリームは変わらないので、読み手が目にする書きかけのストリームはありません。
  run をライブで見るのは stderr の進捗の出力の仕事であり、このストリームの仕事ではありません。
- `meta` は scenario を実行した nukadoko の version を名指し、`testRunStarted` と `testRunFinished` は run.json が記録した run 自身の開始と終了を運びます。
  同じ run を 2 回描き出すと、id を除いて同じストリームになります。
- cucumber-messages には、test case がどの environment に対して走ったかを書くフィールドがありません。
  そのため 2 つ以上の environment にわたる run(`--env a --env b`)では、各 pickle に environment ごとの複製を 1 つずつ与えます。
  複製は新しい id を持ち、名前の後ろの丸括弧に environment が入ります(`checkout (staging)`)。
  Examples の行がそれぞれ自分の pickle を持つのと同じやり方です。
  1 つの environment だけの run は、parse したままの pickle を使います。
  このストリームから `@cucumber/junit-xml-formatter` で作った JUnit レポートがその名前を示すのは、Examples の行だけです(`a cart with items - #1.1: a cart with items (staging)`)。
  formatter は test case の名前を pickle ではなく Gherkin の scenario から付け、pickle の tag も property も出力しないので、素の Scenario の environment を書ける、formatter が出力するフィールドはこの形式にありません。
  そうした Scenario を 2 つの environment で走らせると、同じ名前の 2 つの test case になり、`--env` が environment を名指した順に並びます。
  JUnit を読み、それらを見分ける必要がある CI のジョブは、1 つのジョブで 1 つの environment を走らせるか、environment を名指す run サマリか Allure の result を読みます。
  1 つの environment で 1 つの pickle を `--repeat` で実行するたびに、それぞれが自分の test case になり、`attempt` は 0、`willBeRetried` は false です。
  どの実行も cell に数えられるからです。
  最後の attempt 以外に `willBeRetried` を付けた 1 つの test case という再試行の形は採りません。
  `@cucumber/query` のような読み手は最後の attempt だけを残すので、red の実行の後に green の実行が続くと green に見えてしまいます。
- このストリームは Allure の result と逆の役割を持ちます。
  Allure は nukadoko の計測の余剰を公開し、このストリームは compat の忠実さを保ちます。
  唯一の仕事は、移行したスイートの既存フォーマッタと JUnit ベースの CI が、nukadoko の run を従来の cucumber-js の run と同じように読み続けられるようにすることです。
- step record の内部情報はストリームに入りません。
  対象はバリデーション済みの result、`mutates`、`observed`、`error.kind`、`calls` です。
  `TestStepResult` と `TestStepFinished` は closed schema(`additionalProperties: false`)であり、そのどれにもフィールドがなく、Allure 自身の `[nukadoko.failure=<kind>]` label のような marker を通じてこっそり忍び込ませることもできません。
  `calls` には、それに加えてもう 1 つの理由があります。
  この形式には step の中の step という概念がそもそもありません。
  そのためスキーマが開いていたとしても、part がここで取る形はありません(「Parts」を参照)。
  Allure がそれを入れ子にできるのは、Allure 自身のモデルがそうしているからです。
- Attachment は step が自分自身について宣言したものだけを含みます: `declared` の attachment とログの行です。
  ログの行は cucumber-js の `text/x.cucumber.log+plain` という media type(`this.log()` が生成するもの)を使います。
  trace、スクリーンショット、HTTP log、バリデーション済みの result は Allure だけに留まります。
  その計測の余剰にはすでに置き場所があり、ここで trace を base64 で埋め込んでも、それを望む消費者がいないままストリームを太らせるだけだからです。
- step の開始と終了は、同じ scenario record から作る Allure のレポートと同じです。
  step record のある step は、その record の `started_at` と `finished_at` を保ちます。
  step record のない step(skipped、undefined、ambiguous、または始まる前に拒否されたもの)は自分の時刻を持ちません。
  そのため両方の形式が、その step を直前の step の終了時刻に幅ゼロで置きます。
  最初の step なら scenario の `started_at` に置きます。
  この基準点は `record.json` だけから読むので、run の後に record から作ったレポートも同じタイムラインになります。
- `testRunFinished.success` は常に run の断定と一致します。
  BeforeAll/AfterAll はこのストリームに書き込む場所を持ちません(汲み取れる run スコープの record が存在しないからです)。
  そのため run スコープのフックが失敗した run は、どの scenario の中にも現れず、ここにしか現れません。
- 内部の一貫性に加えて、実際の消費者がストリームの動作を確認しています。
  このストリームを `@cucumber/junit-xml-formatter@0.14.0`(envelope ストリームの上で `@cucumber/query` を駆動するもの)に通してもエラーは投げられず、解決が必要なすべての id(pickle から testCase、testStepFinished へ、そして `pickleStepId` から gherkin の step へ)は解決できます。
  失敗した scenario の `<failure>` は step 自身のエラーメッセージを運び、`<system-out>` は step ごとの passed/failed/skipped の trace を運び、`<testsuite tests="...">` は実際の scenario 数と一致します。
  `<failure>` 自体には `type` も `message` の属性も付きません。
  `TestStepResult.exception` が決してセットされないからです(後述)。
  この確認ができているのは junit-xml の経路だけです。
  公式の HTML レポートやサードパーティの formatter はまだこのストリームに対して試されていません。
  確認できているのは、これが実際の消費者がエラーなく読める well-formed な cucumber messages ストリームであるということであり、既存のあらゆる formatter がこれをレンダリングできるということではありません。

正直な限界も、隠さずに書いておきます。
フックは 1 つの汎用 Before と 1 つの汎用 After に潰れます。
同じ種類の hook が 1 つの Hook envelope を共有するからです。
保存された `name` は、Allure の fixture、run サマリで失敗した hook、trace chunk、失敗メッセージのタイトルになります。
その共有 envelope の名前にはなりません。
フック自身の duration は常にゼロです。
これは Allure の result が抱えるのと同じ限界です。
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

## check と注記

`nuka check` は、プロジェクトを実行せずに nukadoko が判断できることをすべて報告します。
所見はそれぞれ、次の 3 つの severity のどれかを持ちます。

- **エラー**(`error`)は、プロジェクトと green な run の間に立ちはだかるものです。
  スキーマに合わない pattern、どの step にも一致しない feature の行、config の誤りがそうです。
  `nuka run` は、選んだ scenario のエラーがあれば実行を拒否します。
- **警告**(`warning`)は、人が見るべき緊張関係ですが、run を止めません。
  `mutates: true` を宣言する step に結び付いた Then、Then のない scenario、どの envFile も定義していないキーを名指す `secrets` のエントリがそうです。
- **注記**(`note`)は、壊れていることではなく腐っていることです。
  プロジェクトはあらゆる check を通過していても、それでも腐ることがあります。
  宣言は、何年も行使されないまま残ることがあります。
  契約は、それを選ばなければならない agent にとって読めなくなることがあります。
  これらの問題は run を止めません。
  しかし、どれも時間とともに高くつくようになります。
  この失敗のパターンが、このツールの名前の由来です。
  ぬか床は毎日の手入れで熟成し、放置すると死にます。

exit code は、報告にエラーが 1 つ以上あるか、`--fail-on`(後述)が名指す code があるときに 1 です。
警告と注記だけなら 0 で終了します。
テキストの出力は、エラー、警告、注記の順に並べます。
`ok: no issues found` を出力するのは、3 つのどれもないときだけです。

注記はプロジェクト全体についての事実です。
step の pattern が結び付いているか、`from` 宣言が一度でも行使されるかは、プロジェクトがスキャンするすべての feature(`featuresDir` と、各 `additionalFeatureDirs` エントリ)で決まります。
そのため、注記を計算するのは対象を指定しない `nuka check` だけです。
対象を指定した `nuka check` と、`nuka run` が実行の前に走らせる check は、注記を計算しません。
`nuka run` は、終わったばかりの run から自分自身の注記 `repeated-scenario-prefix` を 1 つ報告します(「実行」を参照)。

注記は、かつては別の `tend` コマンドが出していました。
nukadoko を使う 11 のプロジェクトを調べたところ、その 14 の code のうち 10 はどのプロジェクトでも発火せず、サマリーを読む人もおらず、使われていたのは 2 つの code でゲートを掛ける 1 つのテストだけでした。
同じプロジェクトを読み込み、同じ文法で所見を出力するコマンドが 2 つあると、ツールを読むすべての agent に負担がかかります。
そこで今は 1 つのコマンドが静的なものをすべて報告し、何でゲートを掛けるかはプロジェクトが `--fail-on` で選びます。

`nuka check --codes` は、すべての code を、その severity、1 行の説明、その code の一般的な fix とともに一覧にします。
`--json` を付けると、同じ一覧を `codes` の下に JSON で出力します。

次の注記は、`nuka check` が何をスタイルの問題ではなく腐敗として読むかを示します。

- **何にも行使されない `from` 宣言**(`from-unused`)。
  その step があらゆる feature 内で出現するたびに、そのキーは行から直接キャプチャされます。
  そのため、宣言された生産者は一度も何も供給しません。
  これはただの事実として報告されます(その宣言は `nuka do --use` を通じてなお到達可能です)。
  削除すべきだという指示としてではありません。
- **どの feature からも束ねられていない pattern を持つ step**(`pattern-unbound`)。
  CLI 専用のつもりの step は pattern を一切持つべきではありません。
  pattern を持っている場合、それは自分が占めていない scenario 上の場所を主張していることになります。
  この注記の `file` は、プロジェクトのルートからの相対パスで step ファイルを名指しします。
  メッセージは、スキャンしたディレクトリを名指しします。
  `additionalFeatureDirs` から漏れたディレクトリでだけ結び付いている step は、結び付いていないように見えるからです。
  `nuka check` と `nuka run` も、同じ step を `undefined-step` のメッセージの末尾で名指しします。
  文や pattern の名前を変えると、1 つの行が未定義になり、1 つの step が結び付けられなくなることが同時に起きるからです。
  この末尾は、対象がより少ないファイルを選んでいても、同じスキャン対象のディレクトリで判断します。
  そのため、対象から外れたファイルで結び付けられている step を結び付けられていないと呼ぶことはなく、1 つの行のメッセージが対象によって変わることもありません。
- **`.describe()` を持たないスキーマフィールド**(`schema-field-undescribed`)。
  これは agent にまっすぐ狙いを定めた注記です。
  agent がフィールドの意味を知る手段は `nuka describe` です。
  description のないフィールドは、名前がすでに伝えていた以上のことを何も agent に伝えません。
  step ファイルを読む人間は周囲のコードを見られます。
  しかし、2 つの step のどちらかを選ぶ agent にはそれができません。
  `from` が埋める args のフィールドは、名指すすべての生産者がその `returns` フィールドに description を持つなら、記述済みとして数えます。
  agent はその値を書きません。
  `nuka describe` が生産者を名指し、その生産者のフィールドが意味を説明します。
  同じ文をすべての消費者に書かせると、ずれていく写しが増えるだけです。
- **description が scaffold の TODO のままの step**(`step-description-todo`)。
  `--description` なしの `nuka scaffold` は `TODO: describe <name>` を書きます。
  それは import でき、行に結び付き、実行もできるので、ほかに報告するものはありません。
  一方で `nuka steps` と `nuka describe` は、step を選ぶ人にその TODO を見せます。
  この注記はその文字どおりの接頭辞だけに一致します。
  そのため、scaffold が書いて誰も置き換えていないものだけを主張します。
  step はそのまま実行できるので、エラーではなく注記です。
- **どの pattern からも使われていない設定済みの parameter type**(`parameter-type-unused`)。
  これは使われていない設定であり、他のものと同様に報告されます。
- **どの型付き step も必要としない `config.fixtures` のエントリ**(`fixture-unused`)。
  直接にも、別の fixture を通しても必要とされないものです(「Fixtures」を参照)。
- **nukadoko が読み込む `.ts` や `.js` のファイルを支配する、`"type"` のない `package.json`**(`package-type-missing`)。
  Node はそのようなファイルを CommonJS として読み、ES module の構文を見つけると解析し直し、`MODULE_TYPELESS_PACKAGE_JSON` の警告を出します。
  これは、そうしたファイルを読み込むたびに起きます。
  支配する `package.json` は Node 自身が使うもの、つまりそのファイルから見て最も近い `package.json` です。
  注記はそれを名指し、直し方を示します。
  `"type": "module"` を追加するか、プロジェクト自身の `.js` ファイルが CommonJS なら `.mts` の名前にすることです。
  run は動くので、これは注記です。

どの envFile も定義していないキーを名指す `secrets.public` や `secrets.redact` のエントリ(`secrets-public-key-unknown`、`secrets-redact-key-unknown`)は、注記ではなく警告です。
その指示は実在しますが、何にも届きません。
自分が記述している対象のファイルから設定がずれているということです。
その隣にある所見は対比する価値があります。
値が短すぎて redact されない `redact` エントリと、secret らしいキーを持つ追跡済みの env file は、どちらも run が始まった瞬間に平文がログに届くことを意味します。

`--fail-on <code>`(繰り返し指定、またはカンマ区切り)は、その code の所見が報告されたときに、その 1 回の呼び出しを 1 で終了させます。
そのことを stderr に `fail-on: <code> reported <n> finding(s)` として告げます。
`--json` では、エンベロープの `fail_on_hits` がそうした code をそれぞれの件数とともに並べます。
所見そのものは、出力の中で自分の severity のままです。
変わったのはそのジョブに対するプロジェクトの方針であって、所見の性質ではないからです。
check の報告に決して含まれない code は、何も分析する前に拒否されるので、打ち間違いが「決して発火しないゲート」になることはありません。
その拒否は `nuka check --codes` を案内します。
これが、他の全員にとってその注記を赤くせずに、pull request のジョブが `pattern-unbound` でゲートを掛ける方法です。

フラグの陰に控えさせる注記はありません。
注記は exit code を変えないので、既定で外す code が減らせるのは出力の量だけです。
その代わりに、素の `--json` を読むゲートは、一度も見ない所見を失います。

`nuka check` は報告するだけで、修復はしません。
直すということは、description を書くこと、step を削除すること、feature を移すことを意味します。
どれも背後に書き手がいる判断です。

## CLI summary

npm パッケージは `nukadoko` で、それがインストールするただ 1 つのコマンドが `nuka` です。
`nuka --help` は最後に、skill を読み込んでいない agent が最初に読むファイル `node_modules/nukadoko/llms.txt` を示します。

```
nuka run [<feature[:line]|dir>...] [--no-check] [--env <name>]...
                              check, then execute scenarios (featuresDir when
                              no target is given). An error nuka check reports
                              for the selected scenarios stops the run before
                              anything executes (exit 2, no record);
                              --no-check skips that check. Step records, plus the Allure
                              and messages exports their config keys turn on.
                              --env targets a named environment ("default"
                              when omitted); repeated, it runs every selected
                              scenario once in each, in order, in one run
                              with one verdict per scenario and environment.
                              :line runs one scenario, for iteration only;
                              its summary covers only that scenario. Each target
                              can be a file, file:line, or directory. Targets
                              form one deduplicated set in deterministic byte
                              order and one invocation: one run_id, one
                              summary, one exit code, one messages stream, and
                              one Allure results tree. :line on a directory is
                              refused, and a
                              directory with no .feature file outside
                              node_modules and dot-directories fails setup,
                              naming what it walked. That skip reports
                              nothing. stderr
                              gets per-step/per-scenario progress as it runs,
                              then every location this run wrote and a summary
                              line. A failed step's line is followed by its
                              error's first line (and an expect's Locator,
                              Expected, Received, and Error lines), a used line
                              for each step
                              it read from whose process exited nonzero
                              (its exit code and first stderr line), and its
                              step record path.
                              Each failed scenario follows the summary with
                              its feature, line, and name, then a rerun
                              line (nuka run <feature>:<line>). Then one retention
                              line, when a run older than the newest
                              retention.runs was removed (see "Artifacts").
                              A repeated-scenario-prefix note names
                              scenarios that open with the same steps up to
                              the first When, docstrings and tables compared
                              too, and what that opening took (measured, no
                              advice); the exit code is unchanged.
                              --json drops every one of these lines, and
                              warnings go into run.json's findings.
                              stdout is empty unless asked: --records
                              prints NDJSON, each scenario's run.json
                              entry, on a terminal or not. --json prints
                              run.json (commit, environments, selection,
                              counts, verdicts, each scenario's steps with line,
                              status, record, and error, each failed
                              scenario's do, the findings) as the one
                              document on stdout instead; run.json is
                              written to runs/<run_id>/ either way. Text project code (a step, a hook, a
                              fixture) writes through console.log or
                              process.stdout.write is delivered on stderr.
                              --concurrency <n> (default 1) hands whole feature
                              files to n worker processes while the parent
                              keeps one run_id, one run.json, one summary,
                              and one exit code.
                              Above 1, stdout lands in completion order and the
                              progress lines are held per scenario. A file
                              tagged @nukadoko:serial runs while no other file runs.
                              --repeat <n> (default 1) runs every selected
                              scenario n times in this one invocation, each
                              execution its own record under the one run_id;
                              a scenario that failed at least once gets a
                              repeat line after the failed list.
                              --since <git ref> compares each scenario's
                              criteria (tags, steps with their effective
                              keyword, docstrings, tables, its Examples row)
                              and the files that register its steps, their
                              parts, and the fixtures they need with the
                              commit the ref names: criteria.changed_since is
                              unchanged, changed, new, ambiguous, or unknown,
                              since lists the removed criteria and the step
                              files that changed, and the summary quotes what
                              moved. It reports only. An unknown ref
                              (since-ref-unknown), a project outside git
                              (since-outside-git), or another git failure
                              (since-git-failed) is refused.
                              Every run writes a Markdown run summary to
                              runs/<run_id>/summary.md and appends it
                              to $GITHUB_STEP_SUMMARY when set, and writes
                              no export file
nuka report [<run dir>] --format markdown|allure|messages [--out <path>] [--json]
                              render one finished run from its run directory
                              alone (markdown: run.json; allure and
                              messages: run.json, the step records,
                              sources.json); with no run dir, the newest
                              run. markdown: the run summary, on stdout or
                              to --out; allure: an allure-results directory,
                              .nukadoko/export/allure-results or --out;
                              messages: a cucumber-messages NDJSON stream, on
                              stdout or to --out. Files written under
                              <stateDir>/export/ leave with the run, and a
                              second render of the same run there replaces
                              the first; no other file is noted. --json prints {run_id, format, written}
                              and needs --out for markdown and messages.
                              A run directory with no run.json is refused
                              (run-not-found), one whose run.json is not
                              one this release reads (run-invalid), and,
                              for allure and messages, one with no
                              sources.json (run-sources-missing) or one
                              whose sources.json is corrupt or of another
                              version (run-sources-invalid). A
                              render that left out part of the run exits
                              1 with report-incomplete. A missing
                              directory on the way to --out is created;
                              anything else in the way is refused
                              (report-out-invalid)
nuka do <step> [--args '<json>'] [--use <step-record-id>] [--env <name>]
                              execute one typed step; step record to stdout.
                              --env as on nuka run; each call starts clean.
                              Text the step or its fixtures write through
                              console.log or process.stdout.write is
                              delivered on stderr.
                              --args is required unless --use supplies
                              every key; --use fills its `from` keys
                              from an earlier execution's result
nuka steps [--json]           list the whole vocabulary, typed and compat:
                              name, file (the step file, relative to the
                              project root), patterns, description, mutates, timeout
                              when the step declared one, which
                              fixtures each step needs (needs, needs_browser,
                              or needs: null plus needs_error for the one it
                              can't read), and where each chained args key
                              comes from (from, or from_errors naming the
                              key and why for the one it can't read);
                              --json prints the envelope with steps beside
                              findings; a step file that failed to import
                              is a step-file-import-failed finding, exiting
                              1 if there is one or
                              any step's needs_error or from_errors is
                              present, output printed either way, and
                              under --json each such part is a
                              contract-unreadable finding naming the
                              step. Text
                              wraps at 80 columns, in a terminal or not
nuka describe <step>          full contract, the step file as file,
                              schemas as JSON Schema, plus
                              timeout when the step declared
                              one, plus
                              the envelope's findings beside it (the same
                              findings as nuka steps'). When args or returns cannot be
                              represented as JSON Schema, that side is null
                              and args_error or returns_error names the step
                              and why; the rest of the contract is still
                              printed. Exits 1 when a step file did not
                              import, or when the described step is typed
                              and carries its own needs_error, from_errors,
                              args_error, or returns_error, each also a
                              contract-unreadable finding naming the
                              step. A broken sibling step
                              elsewhere in the vocabulary does not fail it
nuka scaffold <name> [--pattern <text>] [--then | --command [<entry point>] [--cwd <key>] [--argv <key>] | --request "<METHOD> <path>" [--body <key>]] [--from <step>.<key>]... [--description <text>] [--replace]
                              typed step template that fails until
                              implemented; the thrown message names the
                              args it was given, so the file compiles
                              under noUnusedParameters. --pattern writes
                              the pattern and one args field per
                              {key:type} capture, and
                              refuses a pattern check would refuse in
                              this project, a type it does not register
                              included, with the registered type names.
                              --then writes mutates: false and no
                              returns, for a step a Then line binds.
                              With exactly one capture and at most one
                              --from, its body asserts instead of the
                              stub: node:assert/strict compares actual
                              (the --from value, or undefined under a
                              TODO) with the capture, and the message
                              is "<key>: expected <value>, got
                              <actual>"; a custom type compares with
                              deepEqual. A chained stdout or stderr
                              string loses one trailing newline before
                              the comparison, the one a program prints
                              last. When every feature line the
                              pattern matches carries a docstring, args
                              gets docstring: z.string(), and for a
                              table, table: z.array(z.array(z.string()));
                              --then compares it as it would a capture.
                              With no such line, or lines that disagree,
                              the key is left out. --command never gets
                              one.
                              --from (repeatable) chains one key of an
                              earlier step's returns: the import of that
                              step's file, an args field typed by its
                              schema (producer.returns.shape.key), the
                              from entry, and the key in run. It refuses a
                              producer that does not return the key and
                              names the keys it does return. The same key
                              given for several steps writes one from
                              entry listing each as a candidate producer;
                              their schemas for the key must have the same
                              JSON Schema, descriptions aside, and the
                              args field reads the first one's. --command
                              writes a When step that runs a program
                              instead of the stub:
                              runCommand(process.execPath, [cli,
                              ...captures], { cwd: scratch.dir() }),
                              returns exitCode, stdout, and stderr (so
                              --from can chain them at once), and
                              const cli = resolve("<entry point>"), the
                              value given, relative to the working
                              directory; a value that is not a file
                              there is refused, and a step name read as
                              the value (--command before the name) is
                              named as such. A .ts, .mts, or .cts entry
                              point is refused when one of its own static
                              imports names a relative .js (.mjs, .cjs)
                              file that is absent while its TypeScript
                              sibling is present: the step runs it with
                              node, which does not rewrite the specifier. Without a value that line
                              holds a TODO, and run throws "fill in the
                              entry point: <file>:<line>" before it calls
                              runCommand, so do and run fail by name at
                              that step while check still passes.
                              --command with --then is refused. A
                              --from key is never argv: it is the
                              program's context, so until it is placed
                              (an env variable, a flag, or --cwd) run
                              throws "pass <keys> where the program reads
                              them: <file>:<line>" with the values.
                              --cwd <key> (with --command) runs the
                              program in the directory that args key
                              holds, { cwd: <key> }, instead of
                              scratch.dir(), and leaves the key out of
                              argv; the key must be a capture or a --from
                              key whose schema is a bare z.string().
                              --argv <key> (with --command) splits that
                              string capture into argv elements on
                              whitespace only, with no quoting rule:
                              ...<key>.split(/\s+/) without empty
                              elements, and the description says so. A
                              key that is no string capture is refused,
                              and the do: line names one that is. The
                              step writes mutates: true, the default,
                              under a comment that says to set it to
                              false when the program changes nothing
                              outside a scratch directory.
                              --request "<METHOD> <path>" writes a When
                              step that sends one request through
                              Playwright's request fixture, unwrapped:
                              request.fetch(path, { method }), resolved
                              against baseURL, returning status
                              (response.status()) and body (the response
                              text). Each {key} in the path is that args
                              key's value, inserted as it is; a {key} no
                              capture or --from fills, and any other
                              brace, is refused. --body <key> sends that
                              args key (a capture, a --from key, or the
                              docstring) as data. A value the request
                              does not read throws "pass <keys> where the
                              request reads them: <file>:<line>" until it
                              is placed. It writes mutates: true under a
                              comment: the method is only a proxy for
                              write semantics. --request is refused with
                              --then or --command, and --body without
                              --request.
                              --description writes the step's
                              description; without it the description
                              is "TODO: describe <name>" (with
                              --command, a sentence about running the
                              program), which nuka check notes as
                              step-description-todo. A file already at
                              the step's path is refused. --replace
                              overwrites it only while it is, byte for
                              byte, what scaffold writes today for that
                              name and path under some set of options:
                              the options are read back from the file
                              (pattern, description, entry point, cwd,
                              --argv key, imports, from entries), and
                              the variant, the attachment, and each
                              chained value's class are tried every way.
                              Any other file is refused with rm in its
                              do: line. Without --replace, such a file's
                              refusal names this same command with
                              --replace
nuka scaffold --feature <path>
                              one stub for each line nuka check <path>
                              reports as undefined-step, so a sentence is
                              typed once, in the feature. The pattern is
                              the line as cucumber-expressions' generator
                              reads it over the project's registry: a
                              quoted literal becomes {value:string}, an
                              integer {value:int}, a decimal
                              {value:float}, keyed value, value2, ... A
                              Then line (and its And/But) gets --then's
                              mutates: false, and with one capture
                              --then's assertion body. A line with a
                              docstring gets a docstring: z.string()
                              key, and one with a table a table key of
                              rows, which a Then compares. The name is the pattern's
                              literal words in kebab-case, with -2, -3
                              added past a name the project already
                              holds; lines that read as one pattern share
                              one file. When the line reads more than one
                              way (a registered type against a built-in),
                              or the reading would also match another
                              line of the project, the pattern is the
                              line as written with no capture, and a
                              "note:" line on stderr says so. An outline
                              line whose Examples rows read as different
                              patterns gets no file and a note. Prints
                              each written path on stdout, then on
                              stderr a "next:" line and, for each stub,
                              nuka scaffold <name> --pattern <pattern>
                              [--then] --replace: the single scaffold
                              that writes that stub again byte for byte,
                              left out for a stub it would write
                              differently. Refuses while
                              a step file does not import, and takes no
                              name, --pattern, --then, --command, --from,
                              --cwd, --argv, --request, --body,
                              --description, or --replace
nuka check [feature..] [--json] [--fail-on <code>]
                              static checks: pattern/schema mismatches, Then
                              binding to mutating steps, undefined steps per
                              feature (each naming the patterned steps no
                              scanned feature line binds), ambiguous steps (one line two patterns
                              both match), duplicate patterns, a pattern
                              that captures the same key twice, a required
                              args key nothing on that line could fill, a
                              required `from` key whose producer is absent,
                              bound later in the scenario (held back while
                              an earlier line matches no step), or
                              ambiguous between two producers, a `from`
                              naming a step discovery never registered, a
                              fixture
                              dependency cycle, a process-scope fixture
                              depending on a scenario-scope one, a page
                              override that owns none of page, context, and
                              pageAs,
                              config coherence, unreadable step files
                              (reported, not fatal, the rest of the project
                              is still checked), a `.cjs` or `.cts` file discovery
                              walks but never imports, a featuresDir scan
                              that found nothing loadable, unsupported hook
                              tag expressions, a compat hook or step declaring more
                              parameters than nukadoko passes (read as a done()
                              callback), a step whose patterns bind different key
                              sets, a table or docstring with no single args key
                              left to fill, a pattern that is unnamed, unterminated,
                              has an invalid capture key, a syntax error, or an
                              unregistered or duplicate parameter type, an
                              undefined-step finding held back until such a cause
                              is fixed, a feature that does not parse, a
                              scenario outline with no Examples row that runs,
                              warnings for a scenario with no Then and for an
                              outline with several rows and no <column> in its
                              name, a
                              fixture that destructures a name nukadoko does not
                              know, a step whose `parts` form a
                              cycle, declare `mutates: false` over a part that
                              mutates, or name something that is not a registered
                              step, a `@nukadoko:serial` tag on a Scenario line (it
                              is only read from the Feature line), a compat step
                              bound in Then position, an envFile that is missing or
                              has an unreadable line, a tracked envFile key that
                              looks secret but is not in secrets.redact, a
                              secrets.redact key too short to redact, a
                              secrets.public or secrets.redact key no envFile
                              defines; with no target, scans featuresDir plus
                              additionalFeatureDirs and adds notes, none of
                              which changes the exit code: a `from` nothing
                              exercises, a patterned step no feature binds
                              (naming the scanned directories), a schema field
                              with no `.describe()`, a description still the
                              scaffold's TODO, a configured parameter type no
                              pattern uses, a fixture no typed step requires,
                              and a package.json with no "type" over a file
                              nukadoko loads; --fail-on <code> (repeatable, or
                              comma-separated) exits 1 when a finding with
                              that code is reported, and the finding keeps its
                              severity; a code a check report never contains
                              is refused;
                              targets select files the way nuka run's do
                              (several files, a directory walked for .feature
                              files), so the errors
                              nuka run prints before executing equal nuka
                              check's for the same targets. :line is refused,
                              since check analyzes whole files. A path that
                              does not exist is named; any other failed read
                              keeps the error's own text
nuka check --codes [--json]   list every finding code nuka check can produce,
                              with a one-line description and the code's
                              general do, instead of checking a project
nuka clean [--dry-run] [--json]
                              delete accumulated runs/do/export under
                              the state directory, all together; --dry-run
                              prints the same plan the real run would act on
                              without removing anything; under export/,
                              only the files a run's manifest names and
                              the contents of allure-results/; the cache/
                              and records/ directories earlier releases
                              left go too
nuka init [--allure] [--server "<command>" --server-url <url>]
                              set up a project; ends with a self-check.
                              Writes nukadoko.config.ts, features/steps/,
                              .nukadoko/, .env, .env.*, and !.env.example in
                              .gitignore, and a package.json
                              "test:scenarios" script ("nuka run") unless one
                              exists; appends the steps and the config to
                              tsconfig.json's include when it leaves them out,
                              or prints one stderr line naming them when the
                              file has comments. --allure writes
                              allurerc.mjs and creates
                              .nukadoko/export/allure-results.
                              --server with --server-url also writes
                              baseURL: <url>, a server fixture that calls
                              runServer on the command (split on
                              whitespace only, no shell) and stops it
                              after the scenario, a request override that
                              destructures the builtin request and
                              server, so every step that sends a request
                              starts the program first, and the
                              StepFixtures declaration for server. One
                              without the other, an empty command, or a
                              URL that is not http(s) is refused with
                              nothing written. Without playwright
                              installed, stderr names its install line.
                              After a passing self-check, its last
                              stderr line names this package's llms.txt
nuka skill path               where the bundled skill lives, for a project
                              that wants the copy matching this nukadoko
```

文字列または数値を 1 つ取るフラグを 2 回以上与えると、nuka はそのフラグを拒否し、そのコマンドは何も書き込みません。
`nuka do` の `--use`、`nuka run` の `--env`、`nuka check` の `--fail-on` は繰り返し可能で、与えた値をすべて与えた順に残します。

テキスト出力(`--json` なし)は、それを読む人間向けに整形されます。
`--json` が機械可読な契約です。
stdout は、報告でも run の結果でも拒否でも、2 つの空白で整形したちょうど 1 つの JSON 文書を出します。
stderr は空です。
進捗、場所、件数、警告の行も、その文書が持つものの写しも出しません。
stdout でも stderr でも、ストリームが端末かどうかで変わる出力はありません。
`nuka steps` はどこでも 80 桁で折り返し、nukadoko は色を書きません。

nukadoko が書く、または出力する JSON の文書はすべて `schema_version` で始まります。
これはその種類の文書に固有の整数です。
対象は step record と envelope です。
`run.json` は `nuka run --json` の envelope なので、envelope の番号を持ちます。
この番号は、文書がすでに持つフィールドの意味、型、名前が変わったとき、またはフィールドが削除されたときに上がります。
フィールドが追加されただけでは上がりません。
読み手は、形を信頼する前にこの番号を確かめます。
step record は 4 です。
2 で、実行が届かなかった `observed` のチャネルが `null` になり、`observed.processes` が常に存在するようになりました。
3 で `session` フィールドがなくなりました。
4 で、`observed` から HTTP メソッドによる 2 つの回数がなくなりました(`observed.http`、`observed.files`、`observed.unmeasured`、プロセスの `stdin` と `env`、`args_origin` も同時に入りました)。
envelope は 3 です。
run.json の scenario から `probes` が、各 step の `observed` から同じ 2 つの回数がなくなりました。
`schema_version` のない record は nukadoko 0.16.1 以前が書いたものです。

### envelope

すべてのコマンドの `--json` は 1 つの envelope を出力します。
テキスト形式を持たない `nuka describe` は、常にそうします。

```json
{
  "schema_version": 3,
  "nukadoko": "0.17.0",
  "command": "check",
  "verdict": "failed",
  "findings": [
    {
      "severity": "error",
      "code": "undefined-step",
      "file": "features/greet.feature",
      "line": 4,
      "message": "No step definition matches \"I run greet with \"Ada\"\"",
      "do": "nuka scaffold --feature features/greet.feature"
    }
  ]
}
```

`command` はコマンドのパス(`check`、`skill path`)で、argv がどのコマンドも名指さないときは `""` です。
`verdict` は終了コードの断定で、0 なら `passed`、2 なら `refused`、それ以外は `failed` です。
コマンド自身のフィールドは `findings` の後に置かれ、5 つのフィールドを置き換えることはありません。
それは `steps`(`nuka steps`)、契約(`nuka describe`)、`fail_on_hits`(`nuka check`)、`run.json` のフィールド(`nuka run`)、計画(`nuka clean`)、`codes`(`--codes`、各エントリは場所を持たない所見)です。
`nuka do` は step record を出力します。
これは報告ではなく record なので、envelope も `--json` も持ちません。
その拒否と警告は stderr の所見です。

### 所見

所見、拒否、失敗した scenario は 1 つの形です。
フィールドは `severity`、`code`、`message` で、わかっているときは `file`、`line`、`step` が続き(fixture についての注記では `fixture`)、その後に `fix` と `do` が続きます。
severity は `error`、`warning`、`note`(`nuka check`、あらゆるコマンドの警告、`nuka run` が報告する注記)、`refused`(「拒否」を参照)、`failed`(失敗した scenario、BeforeAll または AfterAll の hook)です。
`file` はプロジェクトのルートからの相対パスです。
1 つの step についての所見では、その step を定義する step ファイルです。
複数の step を挙げる `duplicate-pattern` では、最後に挙げた step のファイルです。
config のエントリについての所見では、config ファイルです。
compat の hook についての所見は `file` を持ちません。
discovery は、どのファイルが hook を登録したかを記録しないからです。

`do` は常に、シェルがそのまま実行できるコマンドです。
値は埋められ、POSIX シェル向けにクォートされます(`nuka scaffold --feature features/greet.feature`、`nuka run features/greet.feature:4`)。
`fix` は言葉で書いた編集で、変えるファイルと書く内容を示します。
編集どうしの選択である次の一手や、nukadoko が埋められない値を持つコマンドは `fix` であり、推測した `do` には決してなりません。
どちらも名指さない所見は、`--codes` が一覧にするコードの一般的な `fix` を受け取ります。
そのため、どの所見も、それを越える方法を示します。
`do` だけを名指す拒否も、その一般的な `fix` を横に残します。
`do` は次に打つコマンドで、`fix` は拒否が変えるよう求めるものだからです。

テキストでは、所見は 1 行の `<severity>\t<code>\t<where>\t<message>` です。
`<where>` は `<file>:<line>`、`<file>`、step 名、または `-` です。
値の中の改行やタブは空白になります。
その後に字下げした行が続くことがあります。
まとめた所見が覆うファイル、次に `  fix: <text>`、次に `  do: <command>` です。
`nuka check --codes` は、各コードを同じ文法で出力します。

### 拒否

報告するものが何もないうちにコマンドが止まるとき、コマンドは拒否します。
対象は、yargs またはコマンドが受け付けないフラグ、読み込めない config、存在しない対象、知らない step 名、そして `nuka run` では、選んだ scenario について `nuka check` が報告するエラーです。
終了コードは 2 で、拒否は severity が `refused` で code を持つ所見です。
code は `invalid-arguments`、`target-not-found`、`config-invalid`、`check-errors` など `nuka check --codes` が一覧にするもの、または同じ原因の check の code です(parse できない feature ファイルは、どのコマンドが見つけても `feature-parse-error` です)。
`--json` のときは envelope の `findings` に入り、`verdict` は `refused` で、stderr は何も出しません。
それ以外のときは、その行が stderr に出ます。
`nuka run` は、`check-errors` の拒否の前に、止まる原因になった `nuka check` の所見を出力します。
次のコマンドがわかっているとき、拒否の `do` はそれを名指しします。
知らない step には `nuka steps`、入っていない peer dependency にはインストールの行、`check` が受け付けない `:line` には `nuka check <file>` です。
プロジェクトのファイルが `nuka scaffold` を妨げるとき(step ファイルがすでにある、または `--from` が名指す step の `returns` がそのキーを持たない)、`fix` がそのファイルへの変更を名指しし、`do` は同じ `nuka scaffold` のコマンドラインです。
それ以外では、`fix` はそのコードの一般的な編集で、`do` はそのコマンド自身の `--help` です。

### ストリームと終了コード

stdout は、コマンドに求められたものを出します。
stderr は、コマンドが何をしているかを人が見るためのものを出します。
終了コードは 3 つのうちどれが起きたかを示すので、スクリプトはどちらのストリームも読まずに「suite を直す」と「呼び出し方を直す」を区別できます。

| 終了コード | 意味 | 例 |
| --- | --- | --- |
| 0 | コマンドは求められたことをし、その報告または run は green です。 | warning だけの `nuka check`、通った `nuka run` |
| 1 | コマンドは実行され、その報告または run が red であるか、実行中に失敗しました。 | `nuka check` のエラー、失敗した scenario、run の一部を書かなかった `nuka report`、失敗した `nuka do` の step、`nuka steps` や `nuka describe` で import できなかった step ファイル、`nuka check` が報告した `--fail-on` の code |
| 2 | コマンドは拒否しました。何も実行されず、何も報告されていません(「拒否」を参照)。 | 知らないフラグやコマンド、読み込めない config、存在しない対象、`nuka check` への `:line`、不正な `--repeat` や `--concurrency`、入っていない peer dependency、書き込みを拒否した `nuka init` や `nuka scaffold`、知らない `--fail-on` の code、`nuka do` や `nuka describe` での知らない step、`nuka check` が報告するエラーで止まった `nuka run` |
| 128 + n | `nuka run` または `nuka do` が、シグナル n を受けて teardown のあと止まりました。 | SIGINT なら 130 |

| コマンド | stdout | stderr |
| --- | --- | --- |
| `nuka run` | `--records` なら 1 行に 1 つの scenario の `run.json` のエントリ、`--json` なら `run.json`(envelope)、それ以外は何も出さない | 進捗、書き込んだ場所、summary の行、`scenario-failed` の所見、警告。`--json` なら何も出さない |
| `nuka do` | step record(失敗した step でも) | 警告の所見 |
| `nuka check` | 報告、`--json` なら envelope | 何も出さない(`--json` なしの拒否と警告、`fail-on` の行を除く) |
| `nuka steps`、`nuka describe` | vocabulary または契約(`steps` は `--json`、`describe` は常に envelope) | import に失敗した step ファイルの所見(`--json` のときは `findings` に入るので除く) |
| `nuka clean` | パスごとに 1 行、`--json` なら envelope | 何も出さない(`--json` なしの拒否を除く) |

`--json` のときの拒否は報告の代わりになります。
envelope は拒否の所見を持ち、コマンド自身のフィールドは持ちません。
step record の `error.kind` は「Records」に一覧があります。

### 報告は寛容に、実行は速く失敗する

壊れた step ファイルへの反応は、この一覧の中で 2 通りに分かれます。
その分かれ目は 1 つの問いです。
そのコマンドはこれから step を実行しようとしているのか、それとも語彙を報告するだけなのか、です。
`nuka steps`、`nuka describe`、`nuka check` は報告する道具です。
それぞれがファイル単位で step を発見します。
そのため、import に失敗した 1 ファイルが、プロジェクトの残り全体がまだ見せられるはずのものまで空にしてしまうことはありません。
`nuka check` はその失敗を `step-file-import-failed` として名指しします。
原因が相対パスの `.js`、`.mjs`、`.cjs` の import で、それが指す `.ts`、`.mts`、`.cts` ファイルが存在しない場合は、Node 自身の文の後ろに、そのファイルと import を直すべきファイルを、どちらもプロジェクトのルートからの相対パスで付け足します。
`nuka steps`/`nuka describe` は同じ所見を(前述のとおり)運びます。
`nuka run`、`nuka do`、`nuka init` はこれから step を実行しよう、あるいはこれから実行するプロジェクトを立ち上げようとしている道具なので、fail-fast のままです。
同じ壊れたファイルは呼び出し全体をそのまま拒否します。
なぜなら、その先へ進むことはこれから実行しようとしている何かにとって危険であり、報告するだけとは違うからです。
その拒否は、そのファイルをプロジェクトのルートからの相対パスで、投げられたエラー自身の文より前に名指しします。
移行中のスイートにとって、glue の一部がまだ壊れているのは通常の状態です。
その状態でまったく動かなくなる報告の道具は、移行のダッシュボードとして役に立ちません。
そのまま押し進んでしまう実行の道具は、実際には一度も読めていない glue に対して実行することになります。

## Out of scope(正直な限界)

- step の実装の意味的な真偽は PR レビューに委ねられます。
  ツールが保証するのは入出力の形と、実行された事実だけです。
- nukadoko は、shell アクセスを持つ agent が `.env` を直接読むことを止められません。
  nukadoko がなくすのは、secret が agent の context を通過する構造的な必要性です。
- green の run サマリは、ソフトウェアが正しいことの証明ではありません。
  それは、合意された scenario が名指しされた 1 つの commit で green だったことを記録するものであり、今日について何も語りません。
  それは、同じ commit が今なら green になるだろうということさえ主張しません。
  run が行われたタイミングに依存する欠陥(あるタイムゾーンで計算され別のタイムゾーンで読まれる日付、時計がまたぐ境界)は、それが run から欠けていたのとまったく同じようにサマリからも欠けており、nukadoko はそれを確かめるために scenario を再実行することはありません。
  正直さとは、サマリが語るのは常にただ 1 回の実行についてだけだということです。
  限界とは、欠陥のまるごと 1 つのクラスがどの 1 回の実行からも見えないということです。
- **このパッケージは ESM だけを出荷します。
  意図してそうしています。**
  `package.json` の `exports` は `import` の条件だけを持ち、`require` の条件はありません。
  ESM のビルドの隣に CommonJS のビルドは無く、増やす予定もありません。
  自分の `package.json` に `"type": "module"` が無いプロジェクトでも nukadoko は使えます。
  そのフィールドが何であっても曖昧さなく ESM として読まれるファイルを通して使います。
  設定は `nukadoko.config.mts`、step ファイルは `.mts` で、そのようなプロジェクトを見たときに `nuka init` と `nuka scaffold` が書くのはこの形です。
  したがって、どちらの場合も nukadoko を import するのは ESM の側であり、CommonJS のプロジェクトが得るのは入口であって、保守し続ける 2 つ目のビルドではありません。
  代償は実在し、それを払うのは既存のスイートです。
  そこで既に `.ts` として書かれている glue は、発見される前にリネームが要ります。
  これは compat の扉が本来求める「import 指定子 1 つ」より重く、リネームが要るファイルは `nuka check` が 1 つずつ名指しします。
  読み込みに失敗した設定は、そのファイルと原因を名指しします。
  CommonJS の `.ts` 設定は、同じリネームの文を受けます。
- **step を `defineStep` に昇格させることは一方通行です。**
  compat の扉が約束するのは compat の資産についてだけです: import を元に戻せば、ただの cucumber-js スイートが残ります。
  `defineStep` には、切り替えて戻す import がありません。
  昇格させた step の body は移ります(`run` は Playwright 自身のオブジェクトに対して書かれており、それは下で述べているのと同じ選択によるものです)。
  けれどもそのスキーマ、step record の `result`、`from` とそれを読む束縛順序のチェック、そしてそれらの上に組まれたあらゆる契約チェックは移らず、ここには元に戻す手段は何もありません。
  埋めるべき欠落としてではなく、限界として述べます: 変換は step ごとの機械的な作業であり、import の可逆性があるのは採用の最初の一歩を安くするためであって、型付き側を選択制にするためではありません。
- **意図的に driver-agnostic ではない。**
  `page` と `request` の fixture は Playwright 自身の `Page` と `APIRequestContext` を返し、compat の扉は移行中の glue に、それがすでに使っていたのと同じオブジェクトを渡します。
  それらを nukadoko 自身のインターフェースの背後にラップすれば、そのラッパーが公開し忘れたあらゆる能力を犠牲にし、ユーザーがすでに知っている語彙を、このツールだけが話す語彙に置き換えることになります。
  それは公式の SDK を通して書くことの正反対です。
  引き換えに、別の driver へ後から差し替えるときは public API と compat の扉が同時に壊れます。
  これは見落としではなく、承知のうえで受け入れています。
  step の本体をある driver の API から別の API へ書き換えることは、agent が得意とする作業です。
  portability のために先にコストを払うことは、driver の差し替えでないあらゆる変更を遅くしてしまいます。
  見直すのは、その差し替えの確率が上昇したと計測されたときであり、それより前ではありません。
- CI レポーティングはありません。
  前の試行の記録を消す retry もありません。
  nukadoko 自身による outbound のネットワーク I/O もありません。
  HTML のレンダリングもありません。
  それは Allure の仕事です。
  scenario は並列に実行されます(`nuka run --concurrency <n>`、「Scenario」を参照)が、それは 1 つの invocation の中の worker プロセスをまたぐ並列だけです。
  1 つのスイートを複数の invocation に分割するフラグはありません。
  record が複数の run id にまたがって散らばったスイートは、どの run サマリも 1 つの run として記述できないからです。

## ロードマップ

- **M1(engine core)**: `defineStep`、`do`、pickle に対する `run`、step record、environment、`check`、`init`。
  secret のオンボーディングは再設計されました。
- **M2(compat API)**: `nukadoko/compat`(Given/When/Then/World/hooks のサブセット)、cucumber-js + Playwright のスイート向け移行ガイド。
- **M3(reporting interop)**: scenario 実行のための cucumber messages(NDJSON)ストリーム(移行チームの既存 formatter、JUnit ベースの CI、HTML レポートを動き続けさせる互換面)と、旗艦ダッシュボードとしての allure-results。
  どちらも最初は run の間に書かれていましたが、いまは `nuka report` が終わった run から描き出します。
- **M4(sign-off)**: green の run を feature の隣にコミットする記録として凍結するコマンドとして実装され、その後削除されました。
  その記録を残し続けたプロジェクトは無かったからです。
  記録が述べていた主張はいま run サマリが、コミットと run id に結び付いた証跡として運び、承認そのものはチームが承認を記録する場所に記録されます(「レビュー」を参照)。
- **M5(skills)**: nukadoko が同梱する skill と、`nuka skill path` です。
  CLI は意図的に小さな動詞の集まりです。
  skill は、それらを agent が指示なしに従えるワークフローに変えるものであり、そのどれもエンジンを変えません。
  skill は Agent Skills specification に従うため、`gh skill install` と Claude Code の plugin marketplace の両方が複数ホストへの配布を担います。
  nukadoko 自身はどのホストのディレクトリにもファイルをコピーしません。
  `nuka skill path` が残るのは、その 2 つには出せないものを答えるためです(インストール済みの nukadoko と同じバージョンの skill の在り処)。
  skill は CLI を説明したものなので、両者のバージョンがずれると記述が虚構になります。
  2 つとも出荷されました。
  **acceptance skill** は受け入れループを最初から最後まで動かします(基準を入力に、`steps` と `describe` で語彙を読み、欠けている操作を scaffold して実装し、scenario を書き、green になるまで `run` し、人がレビューする pull request へ渡す)。
  **migration skill** は compat の監査が計測したことを運びます(実際の cucumber-js のスイートが実際にぶつかる gap を、ドキュメントの順序ではなくつまずく順序で)。
  その最初の段階は `nuka check` がそれらの gap を報告することに依存しており、`nuka check` は今それを行っています(「Compat steps」を参照)。
  どちらの skill も、CLI がすでに答えられる事実(語彙、契約、拒否の根拠)を書き写しません。
  それらを書き写した skill は、コマンドが変わった瞬間から嘘をつき始めるからです。
  migration skill は、のちに削除されました。
  移行はスイートごとに一度しか起きないので、その決まりは docs/migration.ja.md(「進め方の決まり」)に移り、エージェントはそこを案内されたときに読みます。
- **M6(chained arguments)**: `from`、`nuka check` と `nuka run` が共有する scenario 順序チェック、`do` の `--use`、そして引用する step record の隣に step 名を記す `used` のエントリです。
  step の入力がどこから来るかは、`run` の本体の中の散文であることをやめ、ツールが読む宣言になります(「step の連鎖」を参照)。
- **M7(tending)**: 壊れることではなく腐ることについての所見を出す `tend` コマンドです。
  `check` が立ち止まる価値を保てるよう、`nuka check` からは外していました。
  のちに `nuka check` に統合されました。
  2 つの code でゲートを掛ける 1 つのテストのほかにそれを実行するプロジェクトはなく、同じプロジェクトを読み込んで同じ所見を出力するコマンドが 2 つあると、ツールを読むすべての agent に負担がかかったからです。
  その所見は `nuka check` の注記になり、どれでゲートを掛けるかは `--fail-on` で選びます(「check と注記」を参照)。
- **M8(fixtures)**: `nukadoko.config.ts` 自身の `fixtures` の下に宣言するユーザー定義の資源です(「Fixtures」を参照)。
  完全な型付けのための `defineFixtures`、scope、step や scenario 自身の成否を運ぶ `use()` ベースの teardown、fixture ごとのタイムアウト、そしてそれらに付随する `check` の所見です。
  typed 側にあった、compat の After hook にはなかった 1 つの gap を塞ぎます。
  受け入れ条件そのものではない片付けを置く場所です。
- **M9(parts)**: `defineStep` の `parts`、`call` fixture、step record が新たに持つ `calls` エントリ、そしてそれに伴う check です(「Parts」を参照)。
  feature ファイルを書き換えずに step を分割できるようになり、scenario の行より小さい粒度での再利用がそもそも可能になります。
- **M10(harvesting)**: 名指しされた `do` の一連の呼び出しから 1 つの feature の下書きを組み立てる `harvest` コマンドです。
  これはのちに削除されました。
  一連の呼び出しを実行した agent はその step をすでに知っており、下書きは scenario が述べるべき主張を空欄のまま残していたからです。
  探索によって見つかった経路は、今も探索した者が書くことで、1 つの文に固定された経路になります。
- **M11(live sessions)**: `session` コマンドの下の `start` と `stop`、プロセス内で開いたまま保持する 1 つの `ctx` でした。
  これにより、`nuka do` はすでに途中まで進んだ world に降り立てました。
  のちに削除されました。
  agent のホストがすでに動かしている Playwright MCP サーバが、nukadoko 自身のプロセスも socket もアイドルタイムアウトもなしに、同じように呼び出しをまたいでブラウザを開いたまま保つからです(「繰り返せない状態」を参照)。
  session の残り、`session list` と `session clear` のコマンドと `do` の `--session` フラグも、その後に削除されました。
  ログイン状態は fixture から得るので、呼び出しをまたいで持ち運ばれる状態はありません。
- **M12(concurrency)**: `nuka run --concurrency <n>`、feature ファイルをまるごと持つ worker プロセス、単独で実行しなければならないファイルのための `@nukadoko:serial`、そしてそれらが動く間 run の identity を保つ親プロセスです(「Scenario」を参照)。
  すべての scenario は依然として同じ直列エンジンの下で実行されます。
  変わるのは、それらが一度に何個実行されるかだけです。
  worker プロセスにしたことが、この高速化をスイートが何に時間を使っているかから独立させ、fixture の teardown 規則をそのまま保たせています。
- **M13(Markdown oaths)**: `.feature` ファイルと同じ pickle にコンパイルされる Markdown ファイルでした。
  のちに削除されました。
  2 つ目の表側には 2 つ目のパーサーと 2 つ目の所見の組が要り、`.feature` ファイルで同じことが言えるからです。
- **M14(exploring、実験的)**: `experimental explore` コマンドでした。
  request だけを使う step に対してモデルまたは関係を実行し、縮小した scenario を貼り付け用に表示しました。
  のちに `defineModel` と `defineRelation` とともに削除されました。
  feature ファイルは人が残すと決めた列の集まりであり、探索で見つかった列はそこに scenario として書かれるからです。
- **Later**: AI 支援の glue コンバータ(既存の正規表現ベースの glue → 型付き step)、tag-expression によるフィルタリング、移行ではなくその場での共存が必要な実際のスイートのための cucumber-js アダプタ。

## 実装ノート

- ランタイム依存: `@cucumber/gherkin`、`@cucumber/cucumber-expressions`、`@cucumber/messages`、`allure-js-commons`、`playwright`、`zod`、`yargs`(CLI)。
  TypeScript はローダーのパッケージを使わず、Node 自身の型の除去で読み込みます。
  Node は `^22.18.0 || >=23.6.0`。
- 形式やプロトコルに公式の SDK があるときは、nukadoko は形式を再実装せず、その SDK を通して書きます(allure-results は allure-js-commons の reporter 機構を、cucumber messages は `@cucumber/messages` を通して)。
  nukadoko 自身はその上の薄い写像層に留まります。
  公式機構の一部を上書きするのは、具体的な必要が現れたときに行う計測された判断であって、既定の選択ではありません。
- id の形式: `<kind>-<timestamp>-<short random>`。
- `nuka steps` と `nuka describe` は step モジュールをインポートします(compat の登録と pattern を集めるにはそれが必要だからです)。
  インポートはファイルのトップレベルのコードを実行するため、実行時と同じ注意が必要です。
  CLI は shell の補完を出荷していません。
- 最初の実世界での検証ゲート(M2 が詳細に設計される前)。
  約 10 個の実際の feature ファイルを結び付け、AI が下書きした型付き step をレビューすることが、手で glue を書くことより実際に優れているかを測ります。
  公開されている 7 プロジェクトの 11 個の feature ファイルに対して実行し、答えは 7 プロジェクト中 6 つで yes でした。
  第二のゲートは typed の方ではなく compat の扉を測るもので、上の Compat steps の節で報告しています。
