# nukadoko

> 実装は、いま生成されるようになった。
> それを検査するものは、そうであってはならない。
> 自然言語の受け入れ基準と、実際に走ったものとのあいだをつなぐ、何かが走る前に検査される型付き step の契約、ツールが計測する step record、そして pull request が運ぶ run サマリ。

> 原文は README.md。
> 相違があれば原文が正。

nukadoko は、型付き step の契約のもとで Gherkin の scenario を実行し、実行ごとに step record を書きます。
この record は agent の報告に頼らず、ツールが計測します。
受け入れ基準は、それを定めた人たちが使う言語のまま残ります。
その文と検証対象のシステムとのあいだにあるものはすべて型を持ち、実行前に検査され、diff でレビューできます。
どの run も、CI が pull request に投稿する Markdown の run サマリで終わります。
人は差分の中の `.feature` とその横のサマリを読み、pull request の承認が sign-off になります。

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
npm install -D -E playwright@1.61.1
npx playwright install chromium
```

入れていなければ、何かが実行される前に `nuka check` がその step とこのインストールコマンドを示し、それ以外のコマンドは `tsc` も含めてすべて動きます。
nukadoko の `page` と `request` の型は、Playwright をインストールするまで `any` です。

## Beside your unit tests

**ユニットテストの横で**

ユニットテスト(vitest、`node:test`)は、関数を内側から検査します。
scenario は、プログラムを外側から検査します。
その文は、変更を求めた人が pull request の上で読めるものです。
日常のループは 4 つだけです: `.feature` ファイル、行の種類ごとに 1 つの `defineStep`、`nuka check`、`nuka run`。

以下の手順では、`Hello, <name>!` を出力する CLI `src/cli.ts` を持つプロジェクトに、scenario を 1 つ追加します。
出力のブロックはすべて、実際の実行からコピーしたものです。

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
CommonJS の場合と、`--allure` と `--env` のフラグは [Setup details](#setup-details) にあります。

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
  async run({ scratch }, { name }) {
    return await runCommand(process.execPath, [cli, name], { cwd: scratch.dir() });
  },
});
```

それをもとに Then の step を scaffold します。
`--from run-greet.stdout` は、import、When の step の `returns` から型を取った `args` のフィールド、そしてその値を Then の step に渡す `from` のエントリを書きます。
`--description` は、その step が確かめる内容を書きます。
省くと description は TODO になり、`nuka tend` がそれを報告します:

```sh
npx nuka scaffold output-says --pattern "the output says {text:string}" --then --from run-greet.stdout --description "The CLI printed exactly this line"
```

```text
features/steps/output-says.ts
```

本体を埋めます。
`text` は feature の行が与えます:

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
  mutates: false,
  run({}, { text, stdout }) {
    if (stdout.trim() !== text) throw new Error(`expected "${text}", got "${stdout.trim()}"`);
  },
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
  step 1/2  ok  0.1s  I run greet with "Ada"
  step 2/2  ok  0.0s  the output says "Hello, Ada!"
steps     .nukadoko/records/steps/      2
scenarios .nukadoko/records/scenarios/  1
summary   .nukadoko/records/runs/run-20261016-123947-b4q6/summary.md
1 scenario: 1 passed, 0 failed  (2s)
```

`nuka run` は、何かを実行する前に、その scenario について `nuka check` が報告する内容を報告し、error があれば止まります。
そのため、どの step にも一致しない行が run に届くことはありません。
`nuka check` を単独で実行すると、同じ check が数秒で済みます。

scenario が失敗すると、stderr は step、そのエラー、その step record、再実行するコマンドを示します。
次の例では、feature が `"Hi, Ada!"` を期待しています:

```text
scenario 1/1  features/greet.feature:4  greets by name
  step 1/2  ok  0.1s  I run greet with "Ada"
  step 2/2  FAIL  0.0s  the output says "Hi, Ada!"
      expected "Hi, Ada!", got "Hello, Ada!"
      record  .nukadoko/records/steps/step-20261016-123950-kjs1
steps     .nukadoko/records/steps/      2
scenarios .nukadoko/records/scenarios/  1
summary   .nukadoko/records/runs/run-20261016-123950-zrhr/summary.md
1 scenario: 0 passed, 1 failed  (1s)
failed  features/greet.feature:4  greets by name
  rerun  nuka run features/greet.feature:4
```

同じ事実が Markdown の run サマリにも入ります。
GitHub Actions では、それがひとりでに job のサマリページに載ります。
その最初の部分は次のとおりです:

```text
<!-- nukadoko:run -->
# nukadoko run failed: 1 scenario, 0 passed, 1 failed

- commit: `507dc66`
- environment: default
- browser: none launched
- nukadoko: 0.15.0
- run: run-20261016-123950-zrhr
- started 2026-10-16T12:39:48.835Z, finished 2026-10-16T12:39:50.265Z (1s)

## features/greet.feature

| scenario | line | status | duration | failure |
| --- | --- | --- | --- | --- |
| greets by name | 4 | failed | 0.1s | step "the output says "Hi, Ada!"": `expected "Hi, Ada!", got "Hello, Ada!"`<br>record `.nukadoko/records/steps/step-20261016-123950-kjs1` |
```

CI では、ユニットテストの横に 1 行加えるだけです([docs/ci.ja.md](docs/ci.ja.md) に workflow 全体があります):

```yaml
- run: npm run test:scenarios
```

`features/`(feature とその step)、`nukadoko.config.ts`、`package.json` の変更をコミットしてください。
`.nukadoko/` はコミットしないでください。
そこには step record、run サマリ、session の状態が入り、平文の生きた認証情報が入ることもあります。
`nuka init` が既に無視の対象にしています。

## An HTTP API

**HTTP API**

`nuka init` は API のプロジェクトも同じように準備します。
上の CLI の手順と違うのは 2 点です。
fixture がサーバを起動し、When の step は `fetch` でそのサーバを呼びます。
ここでは `src/server.ts` が `startServer()` を export します。
`startServer()` は空いているポートで待ち受け、`{ url, close() }` で resolve します:

```ts
// nukadoko.config.ts
import { defineConfig, defineFixtures } from "nukadoko";
import { startServer } from "./src/server.ts";

export default defineConfig({
  fixtures: defineFixtures({
    server: [
      async ({}, use) => {
        const server = await startServer();
        await use(server);
        await server.close();
      },
      { scope: "process" },
    ],
  }),
});

declare module "nukadoko" {
  interface StepFixtures {
    server: Awaited<ReturnType<typeof startServer>>;
  }
}
```

`{ scope: "process" }` は、scenario ごとではなく `nuka run` 全体で 1 つのサーバを起動します。
サーバは、step が初めて `server` を分割代入したときに起動します。
`use()` の次の行が teardown です。
`declare module` のブロックは、`tsc` のために `server` に型を付けます。
`nuka check` は fixture の名前をソーステキストから読むので、このブロックを必要としません。

```ts
// features/steps/get-greeting.ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "GET /greet/<name> from the server under test",
  pattern: "I request the greeting for {name:string}",
  args: z.object({ name: z.string() }),
  returns: z.object({ status: z.number(), message: z.string() }),
  async run({ server }, { name }) {
    const response = await fetch(`${server.url}/greet/${encodeURIComponent(name)}`);
    const body = (await response.json()) as { message: string };
    return { status: response.status, message: body.message };
  },
});
```

`fetch` には何もインストールする必要がありません。
サーバを呼ぶもう 1 つの方法は、Playwright の `APIRequestContext` である `ctx.request()` です。
こちらは `playwright` のインストールが必要です。
step の呼び出しを step record の `observed.http_reads` と `observed.http_writes` に数えるのは `ctx.request()` だけです。
`fetch` の呼び出しでは、どちらも 0 のままです。

Then の step は `nuka scaffold message-is --pattern "the message is {text:string}" --then --from get-greeting.message` で作ります。
`output-says` を `run-greet` から作ったのと同じ方法です。
feature は次のとおりです:

```gherkin
# features/greet.feature
Feature: greet API

  Scenario: greets by name
    When I request the greeting for "Ada"
    Then the message is "Hello, Ada!"
```

## More

**その他**

上のループの先にあるものを、1 行ずつ挙げます:

- [Wrong before it runs](#wrong-before-it-runs): 何かが実行される前に `nuka check` が捕まえるもの、および `nuka do` で 1 つの step だけを実行すること。
- [Markdown oaths](#markdown-oaths): 同じ step を、`.feature` ではなく Markdown ファイルの文の裏に置く。
- [モデルを探索する](#モデルを探索する): `nuka explore` が request だけの step の列を生成し、失敗する最短の列を出力する。
- [The compat door](#the-compat-door): import を 1 つ切り替えて、既存の cucumber-js のスイートを取り込む。
- [Reports fill themselves](#reports-fill-themselves): Allure と cucumber-messages の emitter。
- [Running this in CI](#running-this-in-ci): ゲート全体を担う 1 つの step、run が遅いときに分ける `nuka check`、`--concurrency`、`--repeat`。
- session、environment、secret([Secrets need no manifest](#secrets-need-no-manifest)、および [docs/spec.ja.md](docs/spec.ja.md) の「Session、environment、secret」): 呼び出しをまたぐログイン状態、名前付きの environment、redact。
- [Skills for coding agents](#skills-for-coding-agents): agent がこのループを回すために読み込む 2 つの skill。
- [The bed has to be tended](#the-bed-has-to-be-tended): 壊れているものではなく腐りつつあるもののための `nuka tend`。
- [Setup details](#setup-details)、[Upgrading](#upgrading)、[Status](#status)、[Why this exists now](#why-this-exists-now)。

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

この項目は、`{ steps, import_failures }` の一方のフィールドである `steps` の下にあります。
`import_failures` は、この呼び出しが import できなかった各 step ファイルを名指しします。
このフィールドは常に存在し、すべての import が成功すれば空です。

何かが実行される前に、`nuka check` があらゆる feature ファイルと step ファイルを読み、各問題を報告します。
未定義の step は、最も単純なケースです。
どの step 定義もその行のテキストに一致しないため、run がたどり着く前に `check` がその行を名指しします。
`nuka check` は `nuka run` と同じ対象、つまり複数のファイルやディレクトリ(`nuka check features/checkout`)を受け、`nuka run` がそれについて選ぶファイルを check します。
対象を渡さなければ、プロジェクト全体を check します。

```
error	undefined-step	features/todo.feature:7	No step definition matches "the todo titled "Walk the dog" is completed"; run `nuka scaffold <name>` to add one
```

pattern を宣言した step のうち、走査する feature ディレクトリのどの行にも結び付けられていないものがあれば、同じメッセージの末尾に `patterned steps no scanned feature line binds:` が付き、その step と pattern とファイルを名指しします。
文や pattern の名前を変えると、ちょうどこの組が残ります。
そのため、2 つ目の step を scaffold する前にこの一覧を読んでください。

`from` の束縛順序違反は、ふつうの glue には表現すらできない種類のケースです。
型付きの契約がなければ、この概念がつなぎ留まる先自体がないからです。
step B が `from` を宣言して step A の返り値を読むとして、この feature では A がその scenario のどこでもまだ実行されていないうちに B が束ねられており、どちらの step も実行されるより前に `check` がそれを検出します:

```
error	from-order-violation	features/chain.feature:11	Step "archive-project"'s from.projectId needs step "create-project" to have already run earlier in this scenario, but "create-project" is never bound anywhere in this scenario. This line would fail args validation with certainty
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
  "result": { "id": "5c07a3aa-d06a-4421-a708-9d69d8a238e3", "title": "Buy milk", "done": false },
  "status": "ok",
  "observed": { "http_reads": 0, "http_writes": 1 }
}
```

(`evidence`、`environment`、`session`、および各種タイムスタンプは、上では紙面の都合で省いています。
実物の step record にはそれらも入っています。)

既存の cucumber-js のスイートも、import を 1 つ切り替えるだけでこの扉に届きます(下の [The compat door](#the-compat-door) を参照)。
ただし compat の step には型付きの契約がなく、`nuka check` にはここで feature の行を突き合わせる相手がありません。
`nuka do` は、そうした step を名前で実行することを一切拒否します。

`check` は安価な静的ゲートであり、`run` は step record の証跡と pull request が運ぶ run サマリを残し、`tend` は定期的に行うものであり、あらゆる変更の前に *run しない* ことが意図されている唯一のものです。

## Markdown oaths

**Markdown oath**

Gherkin は、同じ型付き step と step record に対する 1 つの表側です。
Varar 式の Markdown oath は、もう 1 つの表側です。
`nukadoko.config.ts` の `oaths` は、ファイル、またはそのディレクトリを名指しします。
デフォルトは `[]` なので、この README は scenario ではありません。

引用またはフェンスされたコードブロックの外にある文は step であり、`.feature` の行と同じ `defineStep` の pattern にマッチします。
どの pattern にもマッチしない文は、書かれた行の `undefined-step` です。
`nuka check features/todo.md` と `nuka run features/todo.md` は、`oaths` に無くても、明示的な `.md` のパスを受けます。
ディレクトリ対象は、その配下にある設定済みの oath を含み、`.feature` ファイルはこれまで通り歩きます。

`examples/todo/features/todo.md` は、`features/todo.feature` と同じ todo の基準に、outline の行を 1 つ足したものです。
このスライスが読むもの、後に残すものは [docs/spec.ja.md](docs/spec.ja.md#markdown-oaths) にあります。

## モデルを探索する

scenario は、人が選んだ 1 つの列です。
モデルは、request だけを使う step のどんな列が何をすべきかを述べ、`nuka explore` はそこから列を生成します。

```
nuka explore features/explore/add-model.ts --seed 1
```

各列は、1 つの seed から取った `draw.int` と `draw.pick` の選択で組み立てられます。
そのため、同じコマンドは同じ列を再実行します。
最初の失敗は縮小されます。
step を削除し、次に選択を小さくし、列がまだ失敗する間だけその編集を残します。
その後 stdout には、見つかった最も短い scenario が、プロジェクト自身の step の pattern で書かれて出ます。
そのまま feature に貼り付けられます。
関係は、宣言された列と、そこから組み立てた 2 本目の列を実行し、結果が食い違うと両方の scenario を表示します。
feature には何も勝手に追加されません。
表示された scenario を人が読んで決めます。
`examples/todo/features/explore/` のモデルは todo アプリに対して動きます。
規則は [docs/spec.ja.md](docs/spec.ja.md#モデルまたは関係を探索する) にあります。

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
あらゆる step は型付きの契約であり(境界でバリデーションされるスキーマ、宣言され実行前に検査される依存関係)、あらゆる実行は、agent ではなくツールが書いた記録を残す。
自然言語の側は柔らかいままにしてある。
人がそこで考える場所だからだ。
その下にあるマッピングは意図的に硬くしてある。
保証を運べるのはその部分だけだからだ。

Gherkin は、これが守るものではない。
これが拠って立つ土台である。
自然言語で受け入れ基準を述べる形式は、そのパーサや、ツール群や、教わらずに読める世代の人々ごと、すでに存在している。
同じ主張をするために、その語彙を再発明するのは虚栄だっただろう。
ここに Cucumber への郷愁はない: 保証を運べなかった部分、すなわち型のない glue、`passed` としか言わない報告、そして実行時には何も意味しないキーワードこそが、これが置き換える部分そのものである。

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

## Status

**現況**

**0.x です。**
1.0 になるまで、public API はどのリリースでも変わり得ます。
これは 0.x の全区間に当てはまるのであって、0.1 で終わる話ではありません。
0.1 に到達するのは roadmap がより多く実現されたという意味であって、公開面が凍結されたという意味ではありません。

テストで実装済みかつカバーされているのは、型付き step、step record、session、environment、secret、`nukadoko/compat`、Allure と cucumber-messages の emitter、Markdown の run サマリ、tending(`nuka tend`)、scenario の harvesting(`nuka harvest`)、モデルと関係(`nuka explore`)、MCP のツール一覧(`nuka experimental mcp-tools`)、Varar 式の Markdown oath、そして 2 つの agent skill です。
未実装なのは、AI 支援によるグルーの変換と、Varar の残り(step の戻り値と文中の語句の比較、すべての方言)です(詳しくは [roadmap](docs/spec.ja.md#ロードマップ) を参照してください)。

メンテナンスは 1 人が公開の場で行っています。
以下で数字を伴う主張はすべて計測済みです。
推測にとどまるものについては、この README がその旨を書きます。

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
2 つのフラグで書くものを増やせます。
`--allure` は Allure emitter を有効にして `allurerc.mjs` を書き([Reports fill themselves](#reports-fill-themselves) を参照)、`--env` は env ファイルを置くプロジェクトのために `.env`、`.env.*`、`!.env.example` を `.gitignore` に追加します。

Node は step ファイルの型を除去して実行するので、2 種類の TypeScript は読み込めません。
実行時の振る舞いを持つ構文(`enum`、`namespace`、コンストラクタのパラメータプロパティ)は拒否され、`nuka check` はその行に `step-file-import-failed` を報告し、書き換え方を示します。
型でしかない名前を `type` なしで import すると import として残り、Node の "does not provide an export named" エラーで失敗します。
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
`nuka init --env` は `.env` と `.env.*` も追加し、`.env.example` は追跡されたままにします。
state directory の中の trace とスクリーンショットは redact されないため、state directory には機密データが含まれます。

</details>

## Upgrading

**アップグレード**

`npm install -D nukadoko@latest` を使ってください。
インストール時に npm はキャレット範囲を書きます。
メジャーバージョンが 0 の間は、キャレットが minor も固定します(`^0.14.1` が許すのは `0.14.x` だけで、`0.0.x` では patch まで固定します)。
そのため `npm update` だけでは最初に入れた minor を超えません。
0.x の間はどのリリースでも public API が変わり得ます。
範囲指定に頼らず、[changelog](CHANGELOG.md) を読んでください。
破壊的変更のあとに実際に何を直すかは、[docs/upgrading.ja.md](docs/upgrading.ja.md) を参照してください。

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
  step が実際に分割代入した名前だけが構築されるため、`page` を一度も名指ししない step はブラウザを起動しません(そうした step を持たないプロジェクトは、[Install](#install) のとおり Playwright そのものをインストールしません)。
  どちらも返すのは Playwright 自身の `APIRequestContext` と `Page` のオブジェクトであり、nukadoko 独自のラッパーではありません。
  そのため既存の Playwright の知識とヘルパーはそのまま持ち込めます。
- 上の `request.post("/projects", ...)` は、その相対パスを `nukadoko.config.ts` 自身の `baseURL` に対して解決します(`URL` が大文字である点は Playwright 自身のキーと同じです)。
  未設定のままだと、絶対 URL しか通りません。
- `nuka do create-project --args '{"name":"acme"}'` は、この step だけを実行して step record を出力します。
  この record は agent の探索ループを構成する単位であり、事前の準備は不要です。

## What it fixes

**何を直すのか**

どの行も、文と実行のあいだの対応づけがかつて緩んでいた場所です。
cucumber-js を引き合いに出しているのは、そこが最もなじみ深い場所だからであって、それだけがこの緩みを持つ層だからではありません。

| The failure | What nukadoko does about it |
|---|---|
| 重複する step(どれが一致したか分からない) | `nuka check` は、何かが実行される前に、同じテキストが 2 回登録されている **duplicate patterns** と、feature の 1 行に異なる 2 つの pattern がどちらも一致し得る **ambiguous steps** を報告します |
| `this.foo`(型のない袋) | step は `returns` スキーマに対して値を返し、後続の step はそのうち 1 つのキーを名前で読むために `from` を宣言します。この依存関係は diff 上で見える import として現れ、読んだ事実は読み手側 step の step record に記録され、束縛の順序が壊れていれば `nuka check` が実行前に検出します(参照: [step の連鎖](docs/spec.ja.md#step-の連鎖)) |
| `passed` としか言わない報告 | あらゆる実行が、バリデーション済みの result、ツール自身が観測したネットワークの読み書き、evidence、environment、target version を記録した step record を書きます |
| 実行時に見つかる undefined な step | `nuka check <feature>` はそれらを実行前に静的に検出して失敗し、何にも一致しなかったテキストの名前を挙げます |
| 黙って状態を変える `Then` | `mutates` は nukadoko が信頼する宣言であり、計測から導き直す数値ではありません。`mutates: true` を宣言した step は、read-only な environment では実行前に拒否され、`Then` に結び付けられていれば `nuka check` が警告します。実際に何が起きたかは、レビューのためにいまも step record に記録されます。 |

最後の項目には、正確な説明が必要です。
このツールはかつて、約束ではなく計測された回数に対して失敗していました。
この挙動は、計測が支えられない主張をしていました。
書き込みの検出は HTTP メソッドをプロキシとして使います。
このプロキシは、GraphQL、RPC-over-POST、純粋な読み取りを POST 上に実装するベンダーの query API では破綻します。
そうした API を呼ぶ正直な `mutates: false` の step も、書き込みに見えます。
一般的な HTTP レイヤーのルールでは、その呼び出しと本物の書き込みを区別できません。
そこで nukadoko は宣言を信頼します。
自身の request context と page を通じて行われたGET と HEAD を除く呼び出しはいまも数えますが、step record はその回数を断定ではなく事実として示します。

## Reports fill themselves

**レポートはひとりでに埋まる**

従来型の Cucumber の実行は、チームが自分で仕込んだ evidence だけをレポートに映します。
各プロジェクトが、trace やスクリーンショットのための hook の boilerplate を書いて保守します。
[Allure](https://allurereport.org/) はテストレポートのダッシュボードで、nukadoko はその形式で結果を emit するだけで、HTML 自体は決してレンダリングしません。
emitter は、追加の設定なしで、あらゆる step record からレポートを満たします。
バリデーション済みの result、trace、HTTP log、observed な読み書き、environment、version を追加します。
そのうち、各 step のバリデーション済み result は、従来型の Cucumber ではレポート側から追加できません。
Cucumber が step の返り値を捨てるためです。

各 step の下には、絶対時刻から組み立てられた、その内部で何が起きたかのタイムラインが置かれます。
到達した段階、それぞれの待ちの実際の所要時間と試行回数、そして assertion を含めて実行された Playwright の呼び出しのすべてです。
1 回の試行と 40 回の試行では直し方が正反対になりますが、それを見分けられるのはレポートの中でここだけです。
ページ自身が述べたこと(console error、捕捉されないエラー、失敗したリクエスト)の件数が step のそばに置かれるので、ページが 3 件の捕捉されないエラーを投げながら通った step は、誰も attachment を開かなくてもそれを語ります。
添付される trace はその step 自身のものであり scenario 全体のものではないため、失敗した step はさがし回らずに直接開けます。
同じ `trace.zip` は step record の下にも単体で置かれており、Allure を介さずに `npx playwright show-trace <evidence.dir>/trace.zip` で直接開けます。
step record も全文がそのまま添付され、それがこの一覧を古びさせずにいる理由です。
step record が後から何を得ても、2 つ目の対応表を覚える必要なくレポートに届きます。

あわせて cucumber-messages(NDJSON)の emitter も同梱されており、移行するチームの既存フォーマッタと JUnit ベースの CI をそのまま動かし続けます。
これは単なる主張ではなく、自前のストリームを `@cucumber/junit-xml-formatter` に通して確認済みです。
[Allure emitter](docs/spec.ja.md#allure-emitter) と [Messages emitter](docs/spec.ja.md#messages-emitter) を参照してください。

どちらの emitter も既定では無効です。
`nukadoko.config.ts` の `allure: {}` または `messages: {}` というキーが、それぞれを有効にします。
`nuka init --allure` は前者を書きます。
キーの中の `allure.resultsDir` と `messages.output` は、出力先を既定の `.nukadoko/export/allure-results` と `.nukadoko/export/messages.ndjson` から移します。

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
これを置かないと、nukadoko のあらゆる失敗は Allure 3 に組み込まれた 1 つの category「Product errors」に落ちてしまい、7 個の `error.kind` のどれにも分類されません。
`init` を使わないプロジェクトは、[examples/allure/allurerc.mjs](https://github.com/meganemura/nukadoko/blob/main/examples/allure/allurerc.mjs) を手でコピーして置くこともできます。

各コマンドに `--output` を渡してください。
Allure はこれを省くとカレントディレクトリの `allure-report/` を既定にし、`watch` もそこへ書き込みます。
つまり既定のままでは、レポートを見ただけで、追跡もされず ignore もされていない生成物がリポジトリのルートに残ります。
`.nukadoko/` の下へ出せば、`nuka init` がすでに gitignore に入れた場所に収まります。

反復中は `watch` を使います。
片方の端末で動かしたまま、もう片方で `nuka run` を実行します。
一時的な scenario snapshot が、完了した step ごとにレポートを更新します。
scenario が終わると、最終 result がライブ表示を置き換えます。
待ち受けるポートはランダムで、`--port` で指定できます。
ブラウザを開くのは `--open` を渡したときだけです。
`nuka init --allure` は `.nukadoko/export/allure-results/` を作るため、最初の `nuka run` より前に `watch` を開始できます。
snapshot の仕組みとライブ視聴中のリトライ表示は [Allure emitter](docs/spec.ja.md#allure-emitter) を参照してください。

`allure-results/` にある完了済みのファイルは書き換えられません。
run のファイルは、その run が最新 `retention.runs` 回(既定 20)より古くなった時点で run と一緒に消えるので、レポートに載るのはその回数ぶんの run です。
`nuka clean --export` はディレクトリを一度に空にします。
一時的な `*-progress-result.json` は scenario の終了時と次の run の開始時に削除されます。

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
執筆は agent のワークフロー(この下で扱う、同梱の skill)であり、エンジンの魔法ではありません。
詳しくは [Self-healing, audited](docs/spec.ja.md#self-healing監査付き) を参照してください。

このループは、スイートが空洞化する別の経路を**捕まえられません**。
scenario を保ったまま、その `Then` が弱くなることがあります。
step record は実行が何をしたかを示しますが、assertion がいまも意味を持つかは示せません。
この問題はレビューで捕まえる必要があり、[What this does not do](#what-this-does-not-do) でも説明しています。

## Skills for coding agents

**コーディング agent のための skill**

nukadoko は [Agent Skills specification](https://agentskills.io/specification) に従う 2 つの skill を同梱しており、Claude Code、Copilot、Cursor、Codex、Gemini CLI のどれからでも読み込めます。

- **acceptance** はチケットの受け入れ基準を、人が承認できる pull request まで運びます(語彙を読み、欠けているものを scaffold し、feature を書き、green になるまで実行し、feature とその run サマリを渡します)。
- **migration** は cucumber-js のスイートを 2 段階で移行させ、どの違いがレシピではなく要点なのかを説明します。

```sh
gh skill install meganemura/nukadoko --all   # both, on any Agent Skills host
nuka skill path                              # the copy matching your installed version
```

どちらの skill も、CLI が答えられる内容を書き写しません(語彙、契約、拒否の理由はすべて `nuka steps`、`nuka describe`、stderr から得られます)。
それらを書き写した skill は、コマンドが変わった瞬間から嘘をつき始めるからです。

skill が代わりに運ぶのは、放っておくと agent が自分では思いつかない規律です。
すなわち、修復を 3 回失敗したらそこで止め、さらに推測を重ねる代わりに状況を報告すること。
契約で `mutates` を宣言している step を最初に実行する前には、一度だけ確認を取ること。
書かれた記録を手で編集しないこと、そしてよりきれいな記録を作るために既存の記録を削除しないこと。
そうしなければ、green な実行を最適化する agent は、green への最も安い経路を見つけてしまいます。
そしてその最も安い経路は、たいてい弱い assertion です。

## The compat door

**compat の扉**

ここまでのどれも、既存のスイートがあることを前提にしていません。
この節は、それがある場合のためのものです。

既存の Cucumber + Playwright スイートを移行するには、import を `@cucumber/cucumber` から `nukadoko/compat` に切り替えます。
同じ pattern の構文、hooks、World はそのまま動き、その間に nukadoko の harness が step record の計測を始めます。
World のサブクラスは `this.page` と `this.request` に代入できます。
その代入は計測されないままです。
その後は各 step を個別に `defineStep` へ昇格できるため、一部だけを昇格したスイートも通り続けます。

扉は入口であり、行き先ではありません。
compat の step は、最初の run から status と時間を持つ step record を得ます。
evidence と `observed` の件数が付くのは、その glue がブラウザや request を `this.openPage()` / `this.openRequest()` で開くようにしてからです([docs/migration.ja.md](docs/migration.ja.md) の measured upgrade)。
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
`.js` や `.mjs` の glue は他と同じように読まれ、`.cjs` のファイルは、後になって何も定義していない step として現れる代わりに、`nuka check` がそれを名指しします。

手順を追ったガイド(監査結果を収録)は [docs/migration.ja.md](docs/migration.ja.md) を、最後まで動く実例は [examples/migration](https://github.com/meganemura/nukadoko/tree/main/examples/migration) を参照してください。

cucumber も Gherkin も無く、Playwright Test だけを使っている場合は別の扉になります。
[docs/migration-playwright-test.ja.md](docs/migration-playwright-test.ja.md) がその道筋です。
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
   usage is hygienic (assertion only, nothing chained that mutates) versus
   not, whether the suite is CommonJS, and where secrets currently live
   relative to where nukadoko expects them.
5. Verdict: adopt / trial / not-yet, with the reasoning.

Do not guess at nukadoko internals beyond what its README and docs/spec.md
state. If something is unclear, not yet implemented, or you don't have
access to a document you need, say so rather than assuming.
```

</details>

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

`nuka run` は自身の進捗と書き込み先も、走りながら stderr に出力します(`--quiet` は進捗だけを黙らせます)。
stdout が端末でないとき(パイプ、ファイル、CI のログ)は、stdout に 1 行 1 件の JSON の scenario record が出力されます。
端末では `--records` を渡したときだけ出力されます。
失敗した step は、進捗行の下にエラーの 1 行目と step record のパスを出力します。
そのため、CI のログだけで失敗の理由が分かります。
失敗した step が、プログラムが 0 以外で終わった step から値を読んでいたときは、その 2 行の間に `used` 行が入ります。
その行は、その step、exit code、stderr の最初の行を示します。
空の stdout を受け取った Then step は、たいていそこで失敗しています。
サマリの後では、失敗した各 scenario に、それを再実行するコマンドを載せた `rerun` 行が付きます。
`--quiet` でも、これらの行はすべて残ります。

```text
  step 2/2  FAIL  0.0s  the sum is 5
      expected 5, got 4
      record  .nukadoko/records/steps/<id>
...
failed  features/sum.feature:3  two and two
  rerun  nuka run features/sum.feature:3
```

同じ事実は、ログではなく人のために書かれた Markdown の run サマリにも入ります。
毎回の run で `.nukadoko/records/runs/<run_id>/summary.md` に書かれ、`$GITHUB_STEP_SUMMARY` が設定されていればそこに追記され、PR のコメント step 向けには `--summary <path>` にも書かれます。
その 1 行目は `<!-- nukadoko:run -->` なので、CI の step は前の push で投稿したコメントを更新できます。

**記録を置き換える retry は恒久的にスコープ外であり、「いまはまだ」ではありません。**
green な scenario は、その待ちが正しい場所に置かれている証拠には一切なりません。
scenario が必要としたあらゆる待ちは、もっと下流のどこかに偶然置かれていても供給され得たものであり、それらを一切通らない経路だけが、待ちが本来どこに属するかを示せます([Design](#design) を参照)。
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
したがって、上で述べた分け方は変わりません。
スイートが大きくなっても PR ゲートを速く保つため、あらゆる PR で `nuka check` を実行し、merge、deploy、夜間の build で `nuka run` を実行します。

`nuka run --repeat <n>` は、選ばれたすべての scenario を 1 回の呼び出しの中で `n` 回実行します。
数回に 1 回だけ再現する失敗のためのものです。
各実行は 1 つの run id の下でそれぞれ自分の record になります。
1 回でも失敗した scenario は、summary の後に `<passed> of <n> passed` の形で集計されます。

## What this does not do

**これがやらないこと**

- **Step record は偽造不可能ではありません。**
  shell アクセスを持つ agent は、step record を含めどんなファイルでも書けます。
  これは secrets と同じ、正直な限界です。
  nukadoko がなくすのは、agent の **説明** を信頼する必要そのものです。
  実行と計測はツール側にとどまり、それを語る agent 側にはありません。
- **assertion が何かを本当に assert しているかは検査しません。**
  ある step がその description の主張どおりに正直に動くかどうかは、PR レビューに委ねられます。
  ツールが保証するのは入出力の形と実行された事実だけです。
  型付きの契約は、空の assertion をレビューで見つけやすくしますが、それを自動的に拒むものは何もありません。
- **`mutates` は信頼される宣言であり、network が示す内容から導き直されるものではありません。**
  書き込みの検出は HTTP メソッドに基づいており、これは書き込みの意味論そのものではなく、そのためのプロキシです。
  純粋にクライアント側だけの状態や、GET で mutate してしまうサーバは、これでは見えません。
  一方で、意味的には純粋な読み取りを POST 上に実装している step(GraphQL、RPC-over-POST、多くのベンダーの query エンドポイント)は、一度も行っていない書き込みとしてカウントされてしまいます。
  この 2 つのケースを一般的な HTTP レイヤーのルールで区別することはできません。
  だからこそ nukadoko は、その回数で step を失敗させるのをやめました。
  詳しい議論は [キーワードの意味論](docs/spec.ja.md#キーワードの意味論) を参照してください。
  その回数はいまも step record と Allure に記録されるため、誤った `mutates` の宣言は事後に反証可能です。
  判断を担うのは宣言とレビューです。
- **CommonJS のスイートは、先にモジュール形式を変えない限り `nukadoko/compat` を使えません**(上記)。
- **CI レポーティングと HTML のレンダリングは組み込まれていません。**
  レンダリングを担うのは Allure のダッシュボードです(上記)。
  CI で何が動き何が動かないか、なかでもリトライだけが計画されていない理由は、[Running this in CI](#running-this-in-ci) で扱っています。

あるチームが、自然言語の層はまったく要らないと結論づけるなら(何を作るか決める人と、チェックを書く人が同じ人たちだというなら)、Playwright Test に直接向かうのは合理的な判断であり、このツールはそれに異を唱えない。
ここでの主張は、その両者が別人であるところから始まり、実装のうちどれだけの部分が、なぜそう書いたのかを尋ねられない何かによって書かれているかに応じて、いっそう強くなる。

## The bed has to be tended

**床には手入れが要る**

nukadoko は、きゅうりを漬ける発酵させた米糠の床です。
それは生きており、毎日手入れをすれば熟成し、放っておけば死にます。
このツールが、あるスイートの step 定義について主張しているのはまさにそれです(書いて終わりの資産ではなく、生きた培養菌だということ)。
そして、これは単に名前についての言い回しにとどまりません。

`nuka check` が問うのは、プロジェクトがいますぐ run できるかであり、あらゆる run の前に読まれることを意図しています。
`nuka tend` が問うのは別の問い、すなわちこれのどこかが腐りつつあるかです。
詳しくは [Tending](docs/spec.ja.md#tending手入れ) を参照してください。
import に失敗した step ファイル。
そのせいで、あらゆる件数からその step が黙って抜け落ちます。
何にも行使されない `from` 宣言。
description のないスキーマフィールドは、ファイルを見る人にはそれで問題なく読めても、2 つの step のどちらかを選ぶ agent には何も伝えません。
そのどれも run を止めはしませんが、だからこそどこか他の場所で言われる必要があったのです。
あらゆる run の前に出力されていたら、本当に止めるべき行までみんなが読み飛ばすことを覚えてしまうでしょう。

これは、床がいまどこにあるか(語彙のうちどれだけが、まだ compat のままではなく型付きになっているか)から始まります。
それは、その数がこれまで step record のディレクトリを読むことでしか見えず、そんなことをする者は誰もいなかったからです。

## 誰が何を読むか

コードを書かずに承認する人が PR で読むのは 2 つのものです。
diff の中の `.feature` を読んで、チケットの意図どおりに書かれているかを確かめます。
run サマリを読んで、何がどの commit で走ったかを確かめます。
`.nukadoko/` の下にあるものと `nuka` のすべての動詞は、エージェントか CI のものです。
`nuka run` は毎回そのサマリを Markdown で書きます。
commit、environment、ブラウザ、feature ごとの表(各 scenario の状態、所要時間、失敗した step)、`mutates: false` と宣言しながら書き込みが計測された step を名指す末尾の節、そして失敗した各 scenario を再実行するコマンドです。
GitHub Actions では設定なしでジョブのサマリページに載り、`--summary <path>` は CI の step が PR のコメントとして投稿できる写しを書きます([docs/ci.ja.md](docs/ci.ja.md))。

PR の承認が sign-off です。
forge がすでに CI のチェックと承認を 1 つの commit に結び付けるので、nukadoko は feature の隣に独自の記録を書きません([レビュー](docs/spec.ja.md#レビュー)を参照)。

## Design

**設計**

設計の全体、すなわち課題設定、型付き step、キーワードの意味論、record、session/environment/secret、レビュー、roadmap、正直な限界は、1 か所にまとまっています: [docs/spec.ja.md](docs/spec.ja.md)。

English: [README.md](README.md) / [docs/spec.md](docs/spec.md)

## License

**ライセンス**

[MIT](LICENSE)
