# nukadoko

> 実装は、いま生成されるようになった。
> それを検査するものは、そうであってはならない。
> 自然言語の受け入れ基準と、実際に走ったものとのあいだをつなぐ、何かが走る前に検査される型付き step の契約、ツールが計測する step record、そして証跡となる run サマリ。

> 原文は README.md。
> 相違があれば原文が正。

nukadoko は、型付き step の契約のもとで Gherkin の scenario を実行し、実行ごとに step record を書きます。
この record は agent の報告に頼らず、ツールが計測します。
受け入れ基準は、それを定めた人たちが使う言語のまま残ります。
その文と検証対象のシステムとのあいだにあるものはすべて型を持ち、実行前に検査され、diff でレビューできます。
どの run も Markdown の run サマリで終わり、run はその受け入れ基準の証跡です。
これらの scenario がこの commit で、この条件のもとで走ったことを示します。
`nuka run --base <ref>` を使えば、基点からどの受け入れ基準が新しく、変わり、変わらず、消えたかも示します。
新しいか変わった各受け入れ基準が基点のコードに対して Then で失敗したかどうか、そして変わっていない各受け入れ基準が、承認されたときの step のもとで今も成り立つかどうかもです。
人は `.feature` とそのサマリを読みます。
その承認をどこに記録するか(pull request のレビュー、変更チケット、監査ログ)はチームが選ぶことで、nukadoko の外にあります。

エンジンは 2 つあります。
npm パッケージは TypeScript で書いた step を実行し、`nukadoko` gem は Ruby で書いた step を実行します([ruby/README.ja.md](https://github.com/meganemura/nukadoko/blob/main/ruby/README.ja.md))。
どちらも同じ feature ファイルを読み、同じように判定しなければなりません。
[conformance/](https://github.com/meganemura/nukadoko/blob/main/conformance/README.md) のケースと scenario は、両方のエンジンに対して走ります。
この README は TypeScript のエンジンを示します。

## Why this exists now

**いま、これが存在する理由**

コードは、ますますこの文と同じような書かれ方をするようになっている。
誰かが欲しいものを説明し、モデルがそれらしいものを生成する。
それはうまく機能するし、そのことによって「検証済み」が意味すべきことも変わる。
実装が確率的に生成されるとき、それを正しいと呼ぶには、生成される *前に* 固定されていて動かない何かが要る。
そうでなければ、検査される側と検査する側が、同じ分布から引かれていることになる。

受け入れ基準は、すでに固定されたものです。
ソフトウェアが何のためのものかを決める人たちが、すでに自然言語で書いています。
欠けていたのは、その言葉を守らせる方法です。
書かれた一文は、起きたか起きなかったかのどちらかである実行へ対応づけられなければなりません。
その対応づけは、出来上がったものへ黙って同意するようにはずれない強度が必要です。

それが、これの正体である。
あらゆる step は型付きの契約であり(境界でバリデーションされるスキーマ、宣言され実行前に検査される依存関係)、あらゆる `Then` は何を比べ、expected の値がどこから来るかを宣言し、あらゆる実行は、agent ではなくツールが書いた記録を残す。
自然言語の側は柔らかいままにしてある。
人がそこで考える場所だからだ。
その下にあるマッピングは意図的に硬くしてある。
保証を運べるのはその部分だけだからだ。

Gherkin は、これが守るものではない。
これが拠って立つ土台である。
自然言語で受け入れ基準を述べる形式は、そのパーサや、ツール群や、教わらずに読める世代の人々ごと、すでに存在している。
同じ主張をするために、その語彙を再発明するのは虚栄だっただろう。
ここに Cucumber への郷愁はない: 保証を運べなかった部分、すなわち型のない glue、`passed` としか言わない報告、そして実行時には何も意味しないキーワードこそが、これが置き換える部分そのものである。

## Install

**インストール**

Node 22 系なら 22.18 以降、それ以外は 23.6 以降が必要です(`package.json` の `engines.node` は `"^22.18.0 || >=23.6.0"`)。
フラグなしで `.ts` ファイルを実行できる最初のリリースです。
nukadoko は config と step ファイルを Node 自身の型の除去で読み込むので、TypeScript のローダーを別途インストールしません。
nukadoko は devDependency です:

```sh
npm install -D nukadoko
```

ブラウザはインストールされません。
Playwright は optional な peer dependency で、`page` か `request` を使う step だけが必要とします。
そうした step を持つプロジェクトは、nukadoko がテストしているバージョンの Playwright と、それが起動するブラウザを追加します:

```sh
npm install -D -E playwright@1.63.0
npx playwright install chromium
```

peer の範囲は `^1.61.1` なので、すでに 1.61.1 より新しい Playwright 1.x を使っているプロジェクトは、その版のままで構いません。

入れていなければ、何かが実行される前に `nuka check` がその step とこのインストールコマンドを示し、それ以外のコマンドは `tsc` も含めてすべて動きます。
nukadoko の `page` と `request` の型は、Playwright をインストールするまで `any` です。

Ruby のプロジェクトでは、代わりに Gemfile へ `gem "nukadoko", group: :test` を加えます。
Ruby 3.4 以降が必要です。
いま何を実行できるかは [ruby/README.ja.md](https://github.com/meganemura/nukadoko/blob/main/ruby/README.ja.md) にあります。

それぞれのエンジンのコマンドと、片方にだけあるフラグは次のとおりです。
この表は [docs/engines.json](docs/engines.json) から作り、conformance のシナリオが各エンジンの `--help` と照らし合わせています。

<!-- engines:begin -->
| コマンド | Ruby | TypeScript |
| --- | --- | --- |
| `nuka init` | あり | あり |
| `nuka scaffold` | あり | あり |
| `nuka check` | `--codes`、`--fail-on` 以外のすべて | あり |
| `nuka run` | あり | あり |
| `nuka report` | あり | あり |
| `nuka verdict` | あり | あり |
| `nuka judge` | あり | あり |
| `nuka steps` | あり | あり |
| `nuka describe` | あり | あり |
| `nuka do` | あり | あり |
| `nuka step` | あり | あり |
| `nuka clean` | あり | あり |
| `nuka skill` | あり | あり |
| `nuka sig` | あり | このエンジンにはない |
<!-- engines:end -->

## Beside your unit tests

**ユニットテストの横で**

ユニットテスト(vitest、`node:test`)は、関数を内側から検査します。
scenario は、プログラムを外側から検査します。
その文は、変更を求めた人が pull request の上で読めるものです。
日常のループは 4 つだけです: `.feature` ファイル、行の種類ごとに 1 つの `defineStep`、`nuka check`、`nuka run`。

以下の手順では、`Hello, <name>!` を出力する CLI `src/cli.ts` を持つプロジェクトに、scenario を 1 つ追加します。
出力のブロックはすべて、実際の実行からコピーしたものです。
自分のプロジェクトに、インストールから CI までを 1 手順ずつ導入するには、[docs/adopting.ja.md](docs/adopting.ja.md) に従ってください。

```sh
npx nuka init
```

```text
nukadoko.config.ts
features/steps
.gitignore
package.json
tsconfig.json
```

`init` は `.gitignore` に `.nukadoko/` を追加し、`package.json` に `test:scenarios` script を追加します。
人も CI も、この 1 つのコマンドを実行します。
`tsconfig.json` の `include` には steps と config を追加し、`.ts` ファイルを名指しする import を `tsc` が受け付けるためのコンパイラオプションも追加します。
`.gitignore` には `.env`、`.env.*`、`!.env.example` も追加します。
CommonJS の場合と `--allure` フラグは [Setup details](docs/guide.ja.md#setup-details) にあります。

When の step を scaffold します。
`--command` は、プログラムを `scratch.dir()` で実行し、その `exitCode`、`stdout`、`stderr` を返す step を書きます。
`scratch.dir()` は空のディレクトリで、scenario の後に削除されます。
`runCommand` は、実行したプロセスを step record に入れます:

```sh
npx nuka scaffold run-greet --pattern "I run greet with {name:string}" --command src/cli.ts
```

```text
features/steps/run-greet.ts
```

`--command src/cli.ts` がエントリポイントを指定するので、このファイルは編集しません。
`resolve` は、`nuka` を実行したディレクトリから読みます。
そこにファイルがないパスは、scaffold が拒否します。
step はエントリポイントを `node` そのもので実行します。
そのため、`.ts` ファイルどうしが `.js` の specifier で import し合うプロジェクトでは、エントリポイントはビルドした後のプログラム(たとえば `--command dist/cli.js`)で、`"pretest:scenarios": "npm run build"` があれば、clone した直後のチェックアウトでも green になります。
`.ts` のエントリポイントが import する `.js` ファイルがなく、その横に `.ts` ファイルがあるときは、scaffold が拒否します。
値を省くと、その行には TODO が残り、埋めるまで step はファイル名と行番号を示して失敗します。
scaffold が書く内容は次のとおりです:

```ts
// features/steps/run-greet.ts
import { defineStep, runCommand, z } from "nukadoko";
import { resolve } from "node:path";

const cli = resolve("src/cli.ts");

export default defineStep({
  description: "Run the command under test in an empty scratch directory",
  pattern: "I run greet with {name:string}",
  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.
  args: z.object({
    name: z.string(),
  }),
  returns: z.object({
    exitCode: z.number().nullable(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  // Set this to false when the program changes nothing outside a scratch directory.
  mutates: true,
  async run({ scratch }, { name }) {
    return await runCommand(process.execPath, [cli, name], { cwd: scratch.dir() });
  },
});
```

それをもとに Then の step を scaffold します。
`--from run-greet.stdout` は、import、When の step の `returns` から型を取った `args` のフィールド、そしてその値を Then の step に渡す `from` のエントリを書きます。
`--description` は、その step が確かめる内容を書きます。
省くと description は TODO になり、`nuka check` がそれを注記として報告します:

```sh
npx nuka scaffold output-says --pattern "the output says {text:string}" --then --from run-greet.stdout --description "The CLI printed exactly this line"
```

```text
features/steps/output-says.ts
```

Then の step には書くべき本体がありません。
step は claim を宣言し、比べるのは nukadoko です。
actual の値は When の step が返した `stdout`、expected の値は feature の行が述べる `text` で、record は両方の値をそれぞれの出どころとともに残します。
greet は行を改行で終えますが、feature の行にその改行はありません。
そのため claim は末尾を削る `view: "text"` を通して `stdout` を読み、このファイルに編集は要りません:

```ts
// features/steps/output-says.ts
import { defineStep, z } from "nukadoko";
import runGreet from "./run-greet.ts";

export default defineStep({
  description: "The CLI printed exactly this line",
  pattern: "the output says {text:string}",
  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.
  args: z.object({
    text: z.string(),
    stdout: runGreet.returns.shape.stdout,
  }),
  from: {
    stdout: [runGreet, "stdout"],
  },
  // The program ends its output with a newline that the feature line does not show.
  claims: [{ actual: "stdout", view: "text", compare: "equal", expected: "text" }],
});
```

feature は 2 つの文そのものです:

```gherkin
# features/greet.feature
Feature: greet

  Scenario: greets by name
    When I run greet with "Ada"
    Then the output says "Hello, Ada!"
```

実行します:

```sh
npm run test:scenarios
```

```text
> test:scenarios
> nuka run

scenario 1/1  features/greet.feature:4  greets by name
  step 1/2  passed  0.1s  I run greet with "Ada"
  step 2/2  passed  0.0s  the output says "Hello, Ada!"
steps     .nukadoko/runs/run-20261016-123947-b4q6/steps/  2
summary   .nukadoko/runs/run-20261016-123947-b4q6/summary.md
run       .nukadoko/runs/run-20261016-123947-b4q6/run.json
1 scenario: 1 passed, 0 failed  (2s)
```

`nuka run` は、何かを実行する前に、その scenario について `nuka check` が報告する内容を報告し、error があれば止まります。
そのため、どの step にも一致しない行が run に届くことはありません。
`nuka check` を単独で実行すると、同じ check が数秒で済みます。

scenario が失敗すると、stderr は step、そのエラー、その step record、再実行するコマンドを示します。
次の例では、feature が `"Hi, Ada!"` を期待しています。
成り立たなかった claim は、両方の値とそれぞれの出どころを示します。
5 行目の step の `stdout` と、文が述べる `text` です:

```text
scenario 1/1  features/greet.feature:4  greets by name
  step 1/2  passed  0.1s  I run greet with "Ada"
  step 2/2  failed  0.0s  the output says "Hi, Ada!"
      claim broken: "Hello, Ada!" (from:run-greet@5.stdout as text) equal "Hi, Ada!" (sentence:text)
      record  .nukadoko/runs/run-20261024-123634-z9t2/steps/step-20261024-123634-s9j0
steps     .nukadoko/runs/run-20261024-123634-z9t2/steps/  2
summary   .nukadoko/runs/run-20261024-123634-z9t2/summary.md
run       .nukadoko/runs/run-20261024-123634-z9t2/run.json
1 scenario: 0 passed, 1 failed  (0s)
failed	scenario-failed	features/greet.feature:4	greets by name: claim broken: "Hello, Ada!" (from:run-greet@5.stdout as text) equal "Hi, Ada!" (sentence:text)
  do: nuka run features/greet.feature:4
```

同じ事実が Markdown の run サマリにも入ります。
GitHub Actions では、それがひとりでに job のサマリページに載ります。
その最初の部分は次のとおりです:

```text
<!-- nukadoko:run -->
# nukadoko run failed: 1 criterion, 0 held, 1 failed

| verdict | criterion | head default |
| --- | --- | --- |
| failed | `features/greet.feature:4` greets by name | fail@6 |

- `features/greet.feature:4` greets by name: a claim broke at line 6 in default
  - step "the output says "Hi, Ada!"": `claim broken: "Hello, Ada!" (from:run-greet@5.stdout as text) equal "Hi, Ada!" (sentence:text)`; record `steps/step-20261024-123634-s9j0`

- commit: `e26cf85`
- environment: default
- browser: none launched
- selection: full
- nukadoko: 0.21.0
- run: run-20261024-123634-z9t2
- started 2026-10-24T12:36:34.018Z, finished 2026-10-24T12:36:34.449Z (0s)

## Claims

Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.

- `features/greet.feature:6` the output says "Hi, Ada!"
  - "Hello, Ada!" (from:run-greet@5.stdout as text) equal "Hi, Ada!" (sentence:text) broken; measured: observed.processes[0].stdout of step-20261024-123634-plgs
```

CI では、ユニットテストの横に 1 行加えるだけです([docs/ci.ja.md](docs/ci.ja.md) に workflow 全体があります):

```yaml
- run: npm run test:scenarios
```

`features/`(feature とその step)、`nukadoko.config.ts`、`package.json` の変更をコミットしてください。
`.nukadoko/` はコミットしないでください。
そこには step record と run サマリが入ります。
`nuka init` が既に無視の対象にしています。

HTTP サーバであるプログラムは `nukadoko.config.ts` の `program` に書き、nukadoko が run ごとにそれを起動します。
同じループをそうしたプログラムに対してたどる手順は [An HTTP API](docs/guide.ja.md#an-http-api) にあります。

## How a run is judged

**run はどう判定されるか**

run は 3 つの層で断定に達します。
どの層も、ツールが書いた record であり、エージェントが打った 1 行ではありません。

1. **何かが走る前。**
   `nuka run` はまず、選んだ scenario について `nuka check` が報告する内容を報告し、error があれば run を止めます。
   どの step にも合わない行、2 つの pattern に合う行、scenario でまだ走っていない step を読む `from` などです。
   何を捕まえるかは [Wrong before it runs](#wrong-before-it-runs) にあります。
2. **Then はそれぞれ claim です。**
   型付きの Then は、アサートするコードを実行しません。
   どの値を読み、その値をどう比べ、期待値がどこから来るかを宣言し、比べるのは nukadoko です。
   成り立たなかった claim は、上の失敗のように、両方の値とそれぞれの出所を名指します。
   [Claims](docs/spec.ja.md#claims) を参照してください。
3. **受け入れ基準はそれぞれ 1 行です。**
   `run.json` と run サマリは断定の表を持ちます。
   受け入れ基準ごとに 1 行、environment ごとに 1 つのセルです。
   必須のセルが通らなかった行は `failed` です。
   `@with:<switch>` タグの付いた scenario は、その switch を切る environment でも対照として走ります。
   そこで Then が 2 回の run で失敗すれば、行は `proven` です。
   通れば行は `held` のままで、Then は switch が変えるものを見ていないということです。
   `nuka run --base <ref>` は、各受け入れ基準の履歴を加えます。
   基点から見て `new`、`changed`、`unchanged`、`removed` のどれかです。
   新しいか変わった受け入れ基準は、基点のコードに対して失敗してはじめて `proven` になり、そうでなければ `unproven` です。
   変わっていない受け入れ基準で step が変わったものは、承認されたときの step のもとで通らなければならず、そうでなければ `moved` です。
   [断定](docs/spec.ja.md#断定)を参照してください。

exit code はこの表に従います。
`failed`、`unproven`、`moved` の行があれば `1` です。
`nuka verdict` は、run を始めずに、最新の run がいまの作業ツリーをそのまま判定し、赤を何も残さなかったかを答えます。

## Wrong before it runs

**実行する前から間違っている**

Gherkin は、受け入れ基準を実行可能な scenario として述べます: `.feature` ファイルの中の `Given` / `When` / `Then` の行であり、各行の裏にあるコードは別に書きます。
これらのキーワードはこのプロジェクトのものではなく Cucumber のものであり、その定義は [Cucumber 自身の Gherkin リファレンス](https://cucumber.io/docs/gherkin/) にあります。
nukadoko はこの形式を Cucumber 自身のパーサで読みます。

```gherkin
Feature: Projects

  Scenario: A new project appears in the list
    Given a project "acme" exists
    Then the project list includes "acme"
```

その行の裏にある語彙を調べるために、ソースを読む必要はありません。
`nuka steps --json` が機械可読な形で一覧にします。
agent の探索ループも、この呼び出しから始まります。
このリポジトリの `examples/todo` には、小さな語彙が入っています。
その出力には次の項目があります:

```json
{
  "name": "add-todo",
  "kind": "typed",
  "patterns": ["a todo titled {title:string} is added"],
  "description": "Create a todo via POST /todos and return the created record",
  "mutates": true,
  "needs": ["request"],
  "needs_browser": false
}
```

この項目は `steps` の下にあり、`steps` はすべての `--json` が出力する envelope `{ schema_version, nukadoko, command, verdict, findings, steps }` の中で `findings` の隣にあります。
この呼び出しが import できなかった各 step ファイルは `step-file-import-failed` の finding になります(足りないパッケージが Playwright のときは `playwright-missing` です)。
すべての import が成功すれば `findings` は空です。

何かが実行される前に、`nuka check` があらゆる feature ファイルと step ファイルを読み、各問題を報告します。
未定義の step は、最も単純なケースです。
どの step 定義もその行のテキストに一致しないため、run がたどり着く前に `check` がその行を名指しします。
`nuka check` は `nuka run` と同じ対象、つまり複数のファイルやディレクトリ(`nuka check features/checkout`)を受け、`nuka run` がそれについて選ぶファイルを check します。
対象を渡さなければ、プロジェクト全体を check します。

```
error	undefined-step	features/todo.feature:7	No step definition matches "the todo titled "Walk the dog" is completed"
  do: nuka scaffold --feature features/todo.feature
```

pattern を宣言した step のうち、走査する feature ディレクトリのどの行にも結び付けられていないものがあれば、同じメッセージの末尾に `patterned steps no scanned feature line binds:` が付き、その step と pattern とファイルを名指しします。
文や pattern の名前を変えると、ちょうどこの組が残ります。
そのため、2 つ目の step を scaffold する前にこの一覧を読んでください。

feature を先に書いたときは、`nuka scaffold --feature <file>` が、`check` が未定義とする行ごとに stub を 1 つ書きます。
これで、それぞれの文を打つのは 1 回だけになります。

```sh
npx nuka scaffold --feature features/greet.feature
```

```text
features/steps/i-run-greet-with.ts
features/steps/the-output-says.ts
features/steps/the-exit-code-is.ts
```

pattern は、cucumber-expressions がその行を読んだとおりのものです。
引用符で囲んだ値は `{value:string}`、整数は `{value:int}`、小数は `{value:float}` になり、Then の行には `observe` が TODO の claim step が書かれます。
値を述べない Then の行には stub を書かず、注記だけを出します。
行の下の docstring は `docstring: z.string()` のキーに、table は行の配列を持つ `table` のキーになります。
`value` の名前を変えるときは、pattern と `args` を一緒に変えてください。
行が 2 通り以上に読めるとき(登録した型と組み込みの型の両方が当てはまるとき)や、その読み方がプロジェクトの別の行にも一致するときは、stub は行そのものを キャプチャなしの pattern にし、stderr の `note:` 行がそのことを伝えます。
stub は `returns` も `from` も宣言しません。
プログラムを実行する When と、その結果を読む Then には、[Beside your unit tests](#beside-your-unit-tests) と同じように、`--command` と `--then --from` で step を 1 つずつ scaffold してください。
そのファイルには stub がすでにあるので、`--replace` を付けます。
そのため `--feature` は stderr の最後に `next:` のブロックを出し、stub ごとに `--replace` 付きの単独の scaffold を示します。
その行はそのままでは stub を同じ内容で書き直すだけなので、そこに上のオプションを足してください。
行が示されるのは、同じバイト列を書くときだけです。
`--replace` は、scaffold が何らかのオプションの組み合わせで書くものと 1 バイトも変わっていないファイル(`--feature` の stub や、オプションを 1 つ間違えた `--command` や `--from` の step)だけを上書きし、誰かが編集したファイルは拒否します。
`--replace` を付けないときは、拒否の `do:` 行が `--replace` を付けた同じコマンドを示します。

`from` の束縛順序違反は、ふつうの glue には表現すらできない種類のケースです。
型付きの契約がなければ、この概念がつなぎ留まる先自体がないからです。
step B が `from` を宣言して step A の返り値を読むとして、この feature では A がその scenario のどこでもまだ実行されていないうちに B が束ねられており、どちらの step も実行されるより前に `check` がそれを検出します:

```
error	from-order-violation	features/chain.feature:11	Step "archive-project"'s from.projectId needs step "create-project" to have already run earlier in this scenario, but "create-project" is never bound anywhere in this scenario. This line would fail args validation with certainty
  fix: Put a line that runs step "create-project" earlier in the scenario.
```

この 2 つのケースは一例にすぎません。
`nuka check --codes` は、既知の finding code を 1 行の説明つきで一覧にし、「何を捕まえられるか」に答えます。
この README には、新しい code が増えると古くなる件数を書きません。

1 つの step を単独で実行するために scenario は必要なく、実行後に何が残るかを確認できます。
結果は pass/fail の 1 行ではなく、step record です。

```json
{
  "step_record_id": "step-20260804-224640-50lp",
  "step": "add-todo",
  "kind": "do",
  "args": { "title": "Buy milk" },
  "args_origin": { "title": "command_line" },
  "result": { "id": "5c07a3aa-d06a-4421-a708-9d69d8a238e3", "title": "Buy milk", "done": false },
  "status": "passed",
  "observed": {
    "processes": null, "http": 1, "files": null, "unmeasured": [],
    "program_log": { "trace_id": "9c41d07e5b2a4f60b1e83d7c2a90f415", "lines": 1, "file": "program-log.txt", "stamped": 1 }
  }
}
```

(`evidence`、`environment`、および各種タイムスタンプは、上では紙面の都合で省いています。
実物の step record にはそれらも入っています。)

`args_origin` は、各引数の出所を示します。
ここではコマンドラインです。
scenario の中では、capture、docstring、table、または前の step の result です。
`observed` は、step の実行中に nukadoko が計測したものを持ちます。
キーは次のとおりです。
`processes` は `runCommand` で起動した各プロセスで、stdin と、渡された環境変数も含みます。
環境変数の値を見せるのは、存在するパス、整数、真偽値のときだけです。
`http` は step が送ったリクエストの数です。
各リクエストは step record の `http.jsonl` の 1 行で、リクエスト本文とレスポンス本文を持ちます。
`files` は、step が scratch のディレクトリで変えたファイルと、`node:fs` で書いたファイルで、その中身も含みます。
`program_log` は、nukadoko がプログラムを起動するとき、step の trace id を持つそのログの行です。
プログラムへの各リクエストは、プログラムが自分のログの行に書ける `traceparent` を運びます。
`url` のプログラムでは `null` です。
`events` は、プログラムが `{events}` を名指すとき、プログラム自身が step の中で何をしたかを報告したもので、文、ジョブ、呼び出しごとに 1 行を [docs/execution-events.ja.md](docs/execution-events.ja.md) の形式で持ちます。
`unmeasured` は、nukadoko が見えたが計測できない操作の一覧です。
たとえば `runCommand` を通さずに起動したプロセスです。
これにより、nukadoko が完全でないと見た record は、完全には見えません。
step がその種類のことを何もしなかったキーは `null` です。

既存の cucumber-js のスイートも、import を 1 つ切り替えるだけでこの扉に届きます(下の [Coming from cucumber-js or Playwright Test](#coming-from-cucumber-js-or-playwright-test) を参照)。
ただし compat の step には型付きの契約がなく、`nuka check` にはここで feature の行を突き合わせる相手がありません。
`nuka do` は、そうした step を名前で実行することを一切拒否します。

`check` は安価な静的ゲートであり、その注記に腐敗が現れます。
`run` は step record の証跡と、run の証跡である run サマリを残します。

## Running this in CI

**CI で実行する**

`nuka check` と `nuka run` はどちらもスクリプトから呼べます。
すべてが保たれていれば `0` で終了し、問題があれば非ゼロで終了します。
そのため、どちらのコマンドもパイプラインへ普通の 1 step として組み込めます。
以下は抜粋です。
[docs/ci.ja.md](docs/ci.ja.md) には、完全な workflow 群と、`npx playwright test` から移るプロジェクトが手作業で追加することが多い 4 項目があります。

```yaml
# excerpt from a CI workflow
- run: npm run test:scenarios      # nuka run: checks, then executes featuresDir, writes step records
```

step は 1 つで足ります。
`nuka run` は、選んだ scenario について `nuka check` が報告する内容を報告し、error が 1 つでもあれば何も実行せずに `1` で終了します。
そのため、失敗しかありえない scenario にブラウザや数分を払うことはありません。
`--no-check` はこの check を飛ばし、そうした scenario をそれでも実行します。
run が遅いときは、`nuka check` を単独で速い PR ゲート(数秒、ブラウザ不要)として置き、`nuka run` は merge や deploy の側に残してください。
このゲートは run と同じファイルやディレクトリを名指しでき(`nuka check features/checkout`)、run が止まるはずの error を報告します。
対象を渡さない `nuka check` は `additionalFeatureDirs` も対象にしますが、対象を渡さない `nuka run` はそれを含みません。

scenario の並列実行、繰り返し、順序のシャッフル、1 回の run での複数の environment、基点のコミットとの比較、そして nukadoko が通るまで step をリトライしない理由は、[CI runs in depth](docs/guide.ja.md#ci-runs-in-depth) にあります。

## Agent-first is a design constraint, not a slogan

**agent-first はスローガンではなく、設計上の制約**

agent は、介助なしにループ全体を完了できなければなりません。
まず語彙を発見し(`nuka steps --json`)、契約を読みます(`nuka describe`、スキーマは JSON Schema です)。
次に 1 つの step を実行し(`nuka do`、step record は stdout に出力され、exit code は意味を持ちます)、バリデーション済みの result を読み、次の呼び出しを選びます。
語彙に操作が欠けているときは、agent が新しい step を scaffold して実装します。
その後、人間が PR をレビューします。

その制約が、この設計の大部分を生み出しました。
step は単独で実行できる必要があるため、依存関係は World ではなくシグネチャに現れます。
これにより、`this.foo` でデータフローを隠すこともできません。
次の呼び出しが result を読めるように、ツールは result を捨てずにバリデーションします。
agent の報告は run の記録にならないため、ツールが step record を書きます。
これらの性質は、agent と人の両方に役立ちます。
agent が動かせるスイートは、人もデバッグできるスイートです。

それはまた、この設計がどこへ伸びていくかも決めている。
end-to-end の実行には、ブラウザと分単位の時間というコストがかかる。
そのため、scenario のどれだけを実行せずに誤りだと判定できるかが、誰にとっても反復の速さをそのまま決める。
agent にとっては、そのループが安価なコマンドでできている分だけ、それがそのまま、自分の作業をどれだけ速く正せるかになる。
ここでのあらゆる宣言は、その代価の一部をそうやって支払っており、実行が失敗するたびに立ち返る問いは、`nuka check` がそれをもっと前に捕まえられなかったか、である。

すべてが機械可読な形(`--json`)を持ちます。
リッチな人間向けレポートは Allure に委ねられます。

## Skills for coding agents

**コーディング agent のための skill**

nukadoko は [Agent Skills specification](https://agentskills.io/specification) に従う 2 つの skill を同梱しており、Claude Code、Copilot、Cursor、Codex、Gemini CLI のどれからでも読み込めます。

- **nukadoko** はチケットの受け入れ基準を、feature とその証跡となる run まで運びます(語彙を読み、欠けているものを scaffold し、feature を書き、green になるまで実行し、人がレビューできるよう feature とその run サマリを渡します)。
- **nukadoko-verification** は、プロジェクトの verification skill(動いているアプリを操作する control CLI と機能の地図)の下に scenario を置き、地図のどの主張を scenario で証明するか、CLI とステップで 1 つのライブラリを共有する方法、バグ報告を直す前に赤で再現する方法、cleanup の後も証拠を残す方法を扱います。

```sh
gh skill install meganemura/nukadoko --all   # both, on any Agent Skills host
nuka skill path                              # the copy matching your installed version
```

既存のスイートの移行には skill がありません。
移行は一度しか起きないので、agent には [docs/migration.ja.md](docs/migration.ja.md) を案内します。
その「進め方の決まり」の節は、移行を行う人やエージェントのために書かれています。

skill を読み込んでいない agent は `node_modules/nukadoko/llms.txt` から始めます。
インストールの事実、ループ、すべてのコマンド、すべての finding code が 1 つのファイルにあります。
`nuka --help` の最後と `nuka init` の最後がこのファイルを指します。

どの skill も、CLI が答えられる内容を書き写しません(語彙、契約、拒否の理由はすべて `nuka steps`、`nuka describe`、stderr から得られます)。
それらを書き写した skill は、コマンドが変わった瞬間から嘘をつき始めるからです。

skill が代わりに運ぶのは、放っておくと agent が自分では思いつかない規律です。
すなわち、修復を 3 回失敗したらそこで止め、さらに推測を重ねる代わりに状況を報告すること。
契約で `mutates` を宣言している step を最初に実行する前には、一度だけ確認を取ること。
書かれた記録を手で編集しないこと、そしてよりきれいな記録を作るために既存の記録を削除しないこと。
そうしなければ、green な実行を最適化する agent は、green への最も安い経路を見つけてしまいます。
そしてその最も安い経路は、たいてい弱い assertion です。

## Coming from cucumber-js or Playwright Test

**cucumber-js や Playwright Test から来る**

既存の Cucumber + Playwright のスイートは、import を `@cucumber/cucumber` から `nukadoko/compat` に 1 つ切り替えて取り込みます。
同じ pattern、hooks、World はそのまま動き、各 step は step record を得て、各 step を個別に `defineStep` へ移せます。
扉は入口であり、行き先ではありません。
compat の step には契約がないので、`nuka check` にはその行と照らすものがなく、green の run が確かめるのは step が走ったことだけです。
CommonJS のスイートは、モジュール形式を変えるまでこの扉を使えません。
手順は [docs/migration.ja.md](docs/migration.ja.md) にあり、公開されている 8 つのスイートの監査は [The compat door](docs/guide.ja.md#the-compat-door) にあります。

Gherkin のない Playwright Test のスイートは、自分のランナーのままです。
[docs/migration-playwright-test.ja.md](docs/migration-playwright-test.ja.md) は、操作を普通の関数に移し、spec と型付き step の両方がそれを呼ぶようにします。
何かを移す前に nukadoko が合うかを確かめるには、[評価用のプロンプト](docs/guide.ja.md#try-it-against-your-own-suite-first)を、自分のリポジトリで動くエージェントに貼り付けてください。

## What this does not do

**これがやらないこと**

- **Step record は偽造不可能ではありません。**
  shell アクセスを持つ agent は、step record を含めどんなファイルでも書けます。
  これは secrets と同じ、正直な限界です。
  nukadoko がなくすのは、agent の **説明** を信頼する必要そのものです。
  実行と計測はツール側にとどまり、それを語る agent 側にはありません。
- **claim がその文の言うとおりの意味を持つかは検査しません。**
  型付きの `Then` は claim を宣言し、ツールが約束することは証明よりも狭いものです。
  record は偽のことを述べません(各ラベルは値が本当に来た場所を名指しし、示す値は比較した値そのものです)。
  また、record の読み手に見えない方法で claim を成り立たせることは、拒否するか成り立たないものにします。
  読み手に見える方法は読み手に委ね、record がそれを示します。
  run サマリは各 claim を文の下に、比較、出所、そして記録されたどのチャネルにも値がないとき(または同じ数値を別のチャネルも持つとき)の `measured: none` とともに出力します。
  `measured: none` は定数がとる姿です。
  また、どの claim も判定しなかった scenario をすべて並べます。
  基準が `equal` を意味していたのに `contains-text` で十分か、`observe` が文の名指すものを読んでいるかは、PR レビューに委ねられます。
  それ以外の step がその description の主張どおりに正直に動くかどうかも、PR レビューに委ねられます。
  ツールが保証するのは入出力の形と実行された事実だけです。
- **`mutates` は信頼される宣言であり、network が示す内容から導き直されるものではありません。**
  HTTP メソッドは書き込みの意味論そのものではなく、そのためのプロキシです。
  純粋にクライアント側だけの状態や、GET で mutate してしまうサーバは、これでは見えません。
  一方で、意味的には純粋な読み取りを POST 上に実装している呼び出し(GraphQL、RPC-over-POST、多くのベンダーの query エンドポイント)は、一度も行っていない書き込みに見えてしまいます。
  この 2 つのケースを一般的な HTTP レイヤーのルールで区別することはできません。
  だから nukadoko は、メソッドから書き込みを推測することはしません。
  詳しい議論は [キーワードの意味論](docs/spec.ja.md#キーワードの意味論) を参照してください。
  step record は計測した各 request を事実として残すため、誤った `mutates` の宣言は事後に確かめられます。
  判断を担うのは宣言とレビューです。
- **step のすべての操作が見えるわけではありません。**
  記録するのは、step が `fetch`、`node:http`、`node:https`、Playwright、グローバルの `WebSocket` を通して送ったもの、`runCommand` で起動した各プロセス、scratch のディレクトリのファイル、そして自分のプロセスの `node:fs` の書き込みです。
  `runCommand` を通さずに起動したプロセス(プログラムと引数の数だけで名指します)、Worker、step が開くか書き込む接続のうち記録したリクエストを運ばないもの、`node:http` の上のライブラリ(`ws` パッケージ)で作った WebSocket がハンドシェイクのあとに運ぶものは `observed.unmeasured` に名前が挙がりますが、それが何をしたかの証拠はありません。
  ネイティブアドオン、子プロセス自身の通信、子プロセスが scratch のディレクトリと自分の作業ディレクトリの外で行う書き込み、step より前に開いた接続を step が読むだけのときのその接続、nukadoko の後に入れたインターセプタ(msw など)が自分で答えた `fetch` は、まったく見えません。
- **CommonJS のスイートは、先にモジュール形式を変えない限り `nukadoko/compat` を使えません**(上記)。
- **CI レポーティングと HTML のレンダリングは組み込まれていません。**
  レンダリングを担うのは Allure のダッシュボードです([Reports fill themselves](docs/guide.ja.md#reports-fill-themselves))。
  CI で何が動き何が動かないか、なかでもリトライだけが計画されていない理由は、[CI runs in depth](docs/guide.ja.md#ci-runs-in-depth) で扱っています。

あるチームが、自然言語の層はまったく要らないと結論づけるなら(何を作るか決める人と、チェックを書く人が同じ人たちだというなら)、Playwright Test に直接向かうのは合理的な判断であり、このツールはそれに異を唱えない。
ここでの主張は、その両者が別人であるところから始まり、実装のうちどれだけの部分が、なぜそう書いたのかを尋ねられない何かによって書かれているかに応じて、いっそう強くなる。

## 誰が何を読むか

コードを書かずに承認する人が読むのは 2 つのものです。
`.feature` を読んで、チケットの意図どおりに書かれているかを確かめます。
run サマリを読んで、何がどの commit で走ったか、そして自分が承認した基点からどの受け入れ基準と step ファイルが変わったかを、その比較が届く範囲で確かめます。
`.nukadoko/` の下にあるものと `nuka` のすべての動詞は、エージェントか CI のものです。
`nuka run` は毎回そのサマリを Markdown で書きます。
commit、各 environment、ブラウザ、feature ごとの表(各 environment での各 scenario の断定、所要時間、失敗した step)、各 Then のすべての claim をその成否と計測したチャネルとともに挙げる Claims の節、どの claim も判定しなかった scenario、ツールが計測できない操作をした各 step、そして失敗した各 scenario を再実行するコマンドです。
GitHub Actions では設定なしでジョブのサマリページに載り、`nuka report --format markdown --out <path>` は CI の step が PR のコメントとして投稿できる写しを書きます([docs/ci.ja.md](docs/ci.ja.md))。

nukadoko が記録するのは証跡であり、承認ではありません。
サマリは自分が述べる commit を名指すので、どこに記録した承認(pull request のレビュー、変更チケット、監査ログ)も、承認した run を指せます。
nukadoko は承認の記録を自分では書きません([レビュー](docs/spec.ja.md#レビュー)を参照)。

各 step を自分の目で見たい人は、エージェントを隣にして 1 つの scenario を walk できます。
`nuka run <file>:<line> --step` は各 step の後で、world、ブラウザ、fixture を開いたまま一時停止します。
エージェントは step record と開いているページのビューをその人に読んで聞かせ、その人の答えが `nuka step next <n> --walk <w>` か `nuka step stop <n> --walk <w>` として返ってきたときにだけ run は進みます。
walk した run はサマリでそのことを述べます。
step の間、プログラムは何に対しても開いていたからです。
これは scenario を理解するための方法であって、承認する run ではありません([人と一緒の walk](docs/spec.ja.md#人と一緒の-walk)を参照)。

## Status

**現況**

**0.x です。**
1.0 になるまで、public API はどのリリースでも変わり得ます。
これは 0.x の全区間に当てはまるのであって、0.1 で終わる話ではありません。
0.1 に到達するのは roadmap がより多く実現されたという意味であって、公開面が凍結されたという意味ではありません。

テストで実装済みかつカバーされているのは、型付き step、step record、claim と断定の表、condition と対照を持つ environment、`--base`、secret、`nukadoko/compat`、`nuka report` による Allure と cucumber-messages の出力、Markdown の run サマリ、`--step` による 1 つの scenario の walk、腐りつつあるものについての注記(`nuka check`)、そして 2 つの agent skill です。
Ruby のエンジンは同じ feature ファイルを読み、[conformance/](https://github.com/meganemura/nukadoko/blob/main/conformance/README.md) のすべてのケースと scenario を通ります。
まだ実行できないものは [ruby/README.ja.md](https://github.com/meganemura/nukadoko/blob/main/ruby/README.ja.md) にあります。
未実装なのは、AI 支援によるグルーの変換です(詳しくは [roadmap](docs/spec.ja.md#ロードマップ) を参照してください)。

メンテナンスは 1 人が公開の場で行っています。
この README で数字を伴う主張はすべて計測済みです。
推測にとどまるものについては、本文がその旨を書きます。

## Where to go next

**次に読むもの**

- [docs/adopting.ja.md](docs/adopting.ja.md): 自分のプロジェクトに、インストールから CI までを 1 手順ずつ導入する。
- [ガイド](docs/guide.ja.md): HTTP API と `fetch`、セットアップの詳細、アップグレード、secret、昇格の前と後の step、nukadoko が直すもの、レポート、自己修復、compat の扉の全体、CI の詳細、`nuka check` が加える注記。
- [docs/ci.ja.md](docs/ci.ja.md): CI の完全な workflow。
- [docs/migration.ja.md](docs/migration.ja.md) と [docs/migration-playwright-test.ja.md](docs/migration-playwright-test.ja.md): 既存のスイートを取り込む。
- [docs/upgrading.ja.md](docs/upgrading.ja.md) と [changelog](CHANGELOG.md): バージョンの間で何が変わり、何をすればよいか。
- [ruby/README.ja.md](https://github.com/meganemura/nukadoko/blob/main/ruby/README.ja.md): Ruby のエンジン。
- [conformance/](https://github.com/meganemura/nukadoko/blob/main/conformance/README.md): 両方のエンジンが同じように判定しなければならないもの。

## Design

**設計**

設計の全体、すなわち課題設定、型付き step、キーワードの意味論、record、environment と secret、レビュー、roadmap、正直な限界は、1 か所にまとまっています: [docs/spec.ja.md](docs/spec.ja.md)。

English: [README.md](README.md) / [docs/spec.md](docs/spec.md)

## License

**ライセンス**

[MIT](LICENSE)
