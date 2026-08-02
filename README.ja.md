# nukadoko

> Gherkin のための生きたぬか床: 型付きの step、receipt、そして agent-first な CLI。

**ぬか床**とは、きゅうりを漬物に変える米ぬかの発酵床のことです。
ぬか床は生きており、毎日手入れをすれば熟成し、放っておけば死にます。
nukadoko があなたの Gherkin について主張しているのはまさにこれです。
feature ファイルとその背後にある型付き step は、書いて終わりのテスト資産ではなく生きた培養菌です。
それを日々手入れするのが agent です。

あなたの `.feature` ファイルは、AI 時代に最も価値が上がる資産です。
Gherkin はすでに、実行可能な自然言語仕様として世界最大級のコーパスです。
agent がそれを読み、実行し、修理する力は年々上がっていくため、このコーパスは長く生きるほど価値が上がります。
足かせは 2 つあります。
目に見えないまま腐っていくグルーコードと、誰にも信用されない報告です。
nukadoko が引き受けるのはその 2 つだけです。
Gherkin 自身の構文、パターンマッチング、レビュー、ダッシュボードは、すでにそれをよく所有しているツールに委ねます。

この信頼の問題は、scenario の scripted な実行そのものには関係しません。
そこではツール自身がすでに実行者であり、疑うべき相手がいないからです。
問題になるのは、その実行の前後にある agent の日常の作業です。
scenario がまだ存在しない段階の探索ループ、agent が自分の PR を検証する場面、アプリが壊れた scenario を agent が self-heal する場面がそれに当たります。
さらに、agent が実行した内容だけでなく agent が書いた内容も対象になります。
step の実行は、その step 自身の `mutates` 宣言に対して計測されるからです。
nukadoko は receipt を偽造不可能だとは言いません。
shell を持つ agent は receipt を含むどんなファイルでも書けます。
これは secrets と同じ、正直な限界です。
nukadoko がなくすのは、そもそも agent の説明を信頼する必要そのものです。
実行と計測はツール側にとどまり、それを語る agent 側にはありません。

## Status

**Pre-0.1。**
M1(engine core)と M2(compat の扉)は実装済みです: `steps`、`describe`、`do`、`run`、`check`、`init`、`scaffold`、session、environment、secret、そして `nukadoko/compat`。
レポートの emitter(M3)は設計のみでまだ実装されていません。
roadmap の全体は [Design](#design) を参照してください。

## Evaluate nukadoko against your project

自分のプロジェクト内で動いている agent に、これをそのまま貼り付けてください(プロンプト本文は agent 向けのため英語のままです)。

```
You are evaluating whether to adopt nukadoko (github.com/meganemura/nukadoko)
for this project's end-to-end / acceptance tests.

1. Read nukadoko's README and its full design spec, docs/spec.md, to
   understand what it actually does today versus what is only designed.
2. Survey this project's existing E2E / acceptance test assets: feature
   files (or equivalent scenarios), the glue/step code behind them, and how
   CI runs them.
3. Report back under exactly these five headings, in this order:

1. Current state — what test suite exists today: scope, coverage, what
   executes it.
2. Fit — how typed steps + receipts would change the way an agent runs
   this suite's checks: which flows become vocabulary, and what the
   explore-execute-decide loop looks like concretely here.
3. First three migration moves — the first commands to run and the first
   slice of steps to bind (e.g. `nuka init`, binding an initial slice of
   steps, promoting the hottest existing step to a typed one).
4. Risks and costs — an estimate of vocabulary size (how many distinct
   typed steps this suite would need), how much of the existing `Then`
   usage is hygienic (assertion only, nothing chained that mutates) versus
   not, and where secrets currently live relative to where nukadoko expects
   them.
5. Verdict — adopt / trial / not-yet, with the reasoning.

Do not guess at nukadoko internals beyond what its README and docs/spec.md
state. If something is unclear, not yet implemented, or you don't have
access to a document you need, say so rather than assuming.
```

## When do you reach for which command

5 つの場面に、5 つのコマンドが対応します。

| 場面 | コマンド | 理由 |
|---|---|---|
| 立ち上げ | `nuka init` → `nuka scaffold` | プロジェクトを用意し、実装するまで失敗し続ける step のテンプレートを scaffold する。 |
| 探索(agent のループ) | `nuka steps --json` → `nuka describe` → `nuka do` | 語彙を発見し、契約を読み、1 つの step を実行してその receipt を読み、次の呼び出しを決める。 |
| 語彙の静的検査 | `nuka check` | pattern とスキーマの不一致、`Then` に結び付いた mutating step、undefined な step を、PR や CI の前に検査する。 |
| 本番の検証 | `nuka run` | scenario を実行する。receipt が証跡の主経路になる。 |
| 態勢の管理 | `nuka session list` / `nuka session clear`、`--env <name>` | 呼び出しをまたいでログイン状態を運ぶ、あるいは消す。実行先の環境を指定する。 |

`check` は安価な静的ゲートで、`run` は指し示すに値する receipt の証跡を残すコマンドです。

## Before / after

これは今日すでに真です。
将来の話ではなく、regex のグルーコードを型付き step に昇格させる話です。
feature 行のテキスト自体は変わりません。
変わるのはその背後にある step の定義だけです。

Before(cucumber-js、位置キャプチャ、型なし、World への stash):

```ts
// features/steps/project.ts (cucumber-js)
import { Given } from "@cucumber/cucumber";

Given("a project {string} exists", async function (name: string) {
  const res = await this.request.post("/projects", { data: { name } });
  const body = await res.json();
  this.project = body; // stashed on World — no schema, no type
});
```

After(`defineStep`、named capture、zod、receipt が付く):

```ts
// features/steps/create-project.ts
import { defineStep } from "nukadoko";
import { z } from "zod";

export default defineStep({
  pattern: "a project {name:string} exists",
  description: "Create a project and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  mutates: true,
  async run(ctx, args) {
    const res = await (await ctx.request()).post("/projects", { data: args });
    return res.json();
  },
});
```

- named capture(`{name:string}`)は、値を名前で `args.name` に結び付けます。
  位置キャプチャでは、同じ型の値 2 つを pattern 内で入れ替えると、どちらの値がどこに入るかが黙って入れ替わります。
  `nuka check` は、それが起きる前に、裸の `{string}` もエラーとして検出します。
- `args` と `returns` は zod のスキーマで、実行境界でバリデーションされます。
  receipt の `result` は、step が返しただけのものではなく、ツールがバリデーション済みのものです。
- `nuka check` は、スキーマの不一致、名前のないキャプチャ、`Then` に結び付いた mutating step といったグルーコードの誤りの一群を、実行時に無症状で失敗する(あるいはまったく失敗しない)代わりに、静的なエラーや警告に変えます。
- `nuka do create-project --args '{"name":"acme"}'` は、この 1 step だけを実行して receipt を出力します。
  agent の探索ループが成り立つ最小単位で、他に何も用意する必要がありません。

**M2: compat という戻り口。**
既存の Cucumber + Playwright スイートの移行経路は、import を 1 つ差し替えることです。
`@cucumber/cucumber` の代わりに `nukadoko/compat` を使います。
pattern の構文も、hooks も、World もそのまま動き続け、その裏で nukadoko のハーネスが receipt の計測を始めます。
他に何がどれだけ変わるかは、推測ではなく実測しました。
公開されている cucumber-js のスイート 8 本のうち、監査を行った時点では import の差し替えだけで通ったものはゼロでした。
監査が見つけた障害をふさいだことで、そのうち 2 本はその後、glue の中に拒まれるものが何もない状態になりました。
残る 6 本は、先に短い機械的な準備が必要です(`nukadoko/compat` がエクスポートしていない import がいくつかある、CommonJS のスイートではモジュール形式の変更が要る、など)。
そうした障害はどれも、スイートの振る舞いを静かに変えるのではなく、import の時点か最初の実行でうるさく失敗します。
step を `defineStep` に昇格させるかどうかは、そのあと step ごとの判断になります。
戻り口は逆方向にも開いています。
import を戻せば、ただの cucumber-js に戻ります。
手順を追ったガイド(監査結果も収録)は [docs/migration.ja.md](docs/migration.ja.md) を、最後まで動く実例は [examples/migration](examples/migration) を参照してください。

**M3(設計済み、未実装): レポートが自動で満ちる。**
従来の Cucumber の実行でレポートに映る evidence は、チームが自分で配線した分です(trace やスクリーンショットのためのフック boilerplate を、プロジェクトごとに書いて保守する形)。
計画されている Allure の emitter は、配線ゼロで全 receipt からレポートを満たします: バリデーション済みの result、trace、HTTP log、observed な読み書き、environment と version です。
そのうちの 1 つ(バリデーション済みの per-step result)は、レポート側のどんな努力でも足せません。
従来の Cucumber は step の返り値を捨てているからです。
あわせて cucumber-messages(NDJSON)の emitter も用意し、移行するチームの既存フォーマッタと CI のレポートをそのまま動かし続けます。
どちらもまだ存在しません。
[docs/spec.md](docs/spec.md#allure-emitter) を参照してください。

## Design

設計の全体、すなわち課題設定、型付き step、キーワードの意味論、receipt、session/environment/secret、sign-off、roadmap、正直な限界は、1 か所にまとまっています: [docs/spec.ja.md](docs/spec.ja.md)(原文は [docs/spec.md](docs/spec.md))。

## License

[MIT](LICENSE)
