# nukadoko

> 実装は、いま生成されるようになった。
> それを検査するものは、そうであってはならない。
> 自然言語の受け入れ基準と、実際に走ったものとのあいだをつなぐ、型付き step の契約とツールが計測する receipt。

> 原文は README.md。相違があれば原文が正。

nukadoko は、型付き step の契約のもとで Gherkin の scenario を実行し、あらゆる実行について receipt を書きます。
それは agent が報告した記録ではなく、ツールが計測した記録です。
受け入れ基準は、それを定めた人たちが使う言語のまま残ります。
その文と検証対象のシステムとのあいだにあるものはすべて型を持ち、実行前に検査され、diff でレビューできます。

## Install

**インストール**

Node 20+(`package.json` の `engines.node` は `">=20"`)。

```sh
npm install -D nukadoko
npx nuka init          # writes nukadoko.config.ts and .nukadoko/ ignores
npx nuka steps         # the vocabulary, empty until you add a step
```

nukadoko は devDependency です。
`dist/` と並べて TypeScript のソースそのものも同梱しているため、stack trace は実際のコードを指し、`node_modules` を読む agent は型だけでなく「なぜそう動くか」まで見えます。

<details>
<summary>まだ `package.json` がありませんか(Rails、Django など Node 以外のリポジトリ)?</summary>

先に作成してください。
`npm init -y` は避けてください。
既存の `README.md` の最初の行を `description` に、ディレクトリ名を `name` にコピーしてしまうため、最小限を手で書くほうが確実です:

```json
{ "private": true, "type": "module" }
```

`"type": "module"` は省略できません。
nukadoko は ESM 専用であり、これがないとあらゆる `nuka` コマンドが `No "exports" main defined in .../node_modules/nukadoko/package.json` で失敗します。
このメッセージは `type` については何も言わず、nukadoko 側で改善することもできません。
Node が諦める時点では、CLI がまだ読み込まれていないからです。
`.nukadoko/` を自分で gitignore する必要はありません。
`nuka init` がそれを書き込みます。

</details>

## Wrong before it runs

**実行する前から間違っている**

Gherkin は、受け入れ基準を実行可能な scenario として述べます: `.feature` ファイルの中の `Given` / `When` / `Then` の行であり、各行の裏にあるコードは別に書きます。

```gherkin
Feature: Projects

  Scenario: A new project appears in the list
    Given a project "acme" exists
    Then the project list includes "acme"
```

その行の裏にある語彙は、ソースを読みに行かないと分からないものではありません。
`nuka steps --json` がそれを機械可読な形で一覧にします。
agent 自身の探索ループが最初に呼ぶのと同じ呼び出しです。
このリポジトリの `examples/todo` には、すでに組み立てられた小さな語彙が入っています。
その出力から 1 件:

```json
{
  "name": "add-todo",
  "kind": "typed",
  "patterns": ["a todo titled {title:string} is added"],
  "description": "Create a todo via POST /todos and return the created record",
  "mutates": true
}
```

何かが実行される前に、`nuka check` があらゆる feature ファイルとあらゆる step ファイルを読み、何が間違っているかを報告します。
未定義の step はその中でも浅いケースです: どの step 定義もその行のテキストに一致せず、run がその行にたどり着くよりも前に、`check` がその行そのものを名指しします。

```
error	undefined-step	features/todo.feature:7	No step definition matches "the todo titled "Walk the dog" is completed"; run `nuka scaffold <name>` to add one
```

`from` の束縛順序違反は、ふつうの glue には表現すらできない種類のケースです。
型付きの契約がなければ、この概念がつなぎ留まる先自体がないからです。
step B が `from` を宣言して step A の返り値を読むとして、この feature では A がその scenario のどこでもまだ実行されていないうちに B が束ねられており、どちらの step も実行されるより前に `check` がそれを検出します:

```
error	from-order-violation	features/chain.feature:11	Step "archive-project"'s from.projectId needs step "create-project" to have already run earlier in this scenario, but "create-project" is never bound anywhere in this scenario. This line would fail args validation with certainty
```

この 2 つは一覧ではなく、あくまで一例です。
「何を捕まえられるか」に答えるのは `nuka check --json` です。
知っているあらゆる finding code を返すので、ここに数を書いて新しいものが増えるたびにずれていく、ということが起きません。

scenario なしで 1 step だけを単独で実行すると、実際にその後に残るものが分かります: pass/fail の 1 行ではなく、receipt です。

```json
{
  "receipt_id": "rcpt-20260804-224640-50lp",
  "step": "add-todo",
  "kind": "do",
  "args": { "title": "Buy milk" },
  "result": { "id": "5c07a3aa-d06a-4421-a708-9d69d8a238e3", "title": "Buy milk", "done": false },
  "status": "ok",
  "observed": { "http_reads": 0, "http_writes": 1 }
}
```

(`evidence`、`environment`、`session`、および各種タイムスタンプは、上では紙面の都合で省いています。
実物の receipt にはそれらも入っています。)

既存の cucumber-js のスイートも、import を 1 つ切り替えるだけでこの扉に届きます(下の [The compat door](#the-compat-door) を参照)。
ただし compat の step には型付きの契約がなく、`nuka check` にはここで feature の行を突き合わせる相手がありません。
`nuka do` は、そうした step を名前で実行することを一切拒否します。

`check` は安価な静的ゲートであり、`run` は receipt の証跡を残し、`accept` は 1 回の green な実行を feature の隣に置く記録として凍結し、`tend` は定期的に行うものであり、あらゆる変更の前に *run しない* ことが意図されている唯一のものです。

その accept の記録は Markdown ファイルで、`<feature-basename>.<date>-<sha>.md` という名前で feature の隣に書かれます: feature の全文、scenario の記録、そして各 step の receipt(evidence は取り除かれたもの)です。

## Why this exists now

**いま、これが存在する理由**

コードは、ますますこの文と同じような書かれ方をするようになっている。
誰かが欲しいものを説明し、モデルがそれらしいものを生成する。
それはうまく機能するし、そのことによって「検証済み」が意味すべきことも変わる。
実装が確率的に生成されるとき、それを正しいと呼ぶには、生成される *前に* 固定されていて動かない何かが要る。
そうでなければ、検査される側と検査する側が、同じ分布から引かれていることになる。

受け入れ基準は、すでにその固定されたものであり、すでに自然言語で、ソフトウェアが何のためのものかを決める人たち自身の手で書かれている。
欠けていたのは、それを本人の言葉どおりに守らせる方法だった。
すなわち、誰かが書いた一文が、起きたか起きなかったかのどちらかである実行へと対応づけられる層であり、その対応づけは出来上がったものに合わせて黙ってずれていくことができないほど固く留められている。

それが、これの正体である。
あらゆる step は型付きの契約であり(境界でバリデーションされるスキーマ、宣言され実行前に検査される依存関係)、あらゆる実行は、agent ではなくツールが書いた記録を残す。
自然言語の側は柔らかいままにしてある。
人がそこで考える場所だからだ。
その下にあるマッピングは意図的に硬くしてある。
保証を運べるのはその部分だけだからだ。

Gherkin は、これが守るものではない。
これが拠って立つ土台である。
自然言語で受け入れ基準を述べる形式は、そのパーサーや、ツール群や、教わらずに読める世代の人々ごと、すでに存在している。
同じ主張をするために、その語彙を再発明するのは虚栄だっただろう。
ここに Cucumber への郷愁はない: 保証を運べなかった部分、すなわち型のない glue、`passed` としか言わない報告、そして実行時には何も意味しないキーワードこそが、これが置き換える部分そのものである。

## Agent-first is a design constraint, not a slogan

**agent-first はスローガンではなく、設計上の制約**

agent は、介助なしにループ全体を完了できなければなりません。
語彙を発見し(`nuka steps --json`)、契約を読み(`nuka describe`、スキーマは JSON Schema として)、1 つの step を実行し(`nuka do`、receipt は stdout に、意味のある exit code とともに)、バリデーション済みの result を読み、次の呼び出しを決めます。
語彙に操作が欠けているときは、agent が新しい step を scaffold して実装し、人間がその PR をレビューします。

その制約こそが、この設計の大部分を生み出しました。
step は単独で実行可能でなければならず、そのため依存関係は World ではなくシグネチャに現れなければなりません。
だからこそ `this.foo` は、データフローを隠す場所ではなくなるのです。
result は次の呼び出しから読めなければならず、そのため捨てられるのではなくバリデーションされなければなりません。
agent によるある実行の報告は、その実行の記録そのものにはなり得ないため、ツールが receipt を書きます。
これらはどれも、agent のために作られ、その後で人間向けに正当化された、というものではありません。
どちらの立場から見ても同じ性質であり、agent が動かせるスイートは、結局のところ人がデバッグできるスイートでもあるのです。

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

テストで実装済みかつカバーされているのは、型付き step、receipt、session、environment、secret、`nukadoko/compat`、Allure と cucumber-messages の emitter、sign-off(`nuka accept`)、tending(`nuka tend`)、そして 2 つの agent skill です。
未実装なのは、AI 支援によるグルーの変換と scenario の harvesting です(詳しくは [roadmap](docs/spec.ja.md#ロードマップ) を参照してください)。

メンテナンスは 1 人が公開の場で行っています。
以下で数字を伴う主張はすべて計測済みです。
推測にとどまるものについては、この README がその旨を書きます。

## Upgrading

**アップグレード**

`npm install -D nukadoko@latest` を使ってください。
インストール時に npm が書くのはキャレット範囲であり、`0.0.x` のバージョンではキャレットは patch まで固定します。
つまり `npm update` だけでは、最初に入れたバージョンから決して動きません。
0.x の間はどのリリースでも public API が変わり得るので、範囲指定に守ってもらうのではなく [changelog](CHANGELOG.md) を読んでください。

## Secrets need no manifest

**secret に manifest は要らない**

すでにある env file を `envFiles` に指定すれば、分類は git が行います。
git が追跡していないファイルは secret source であり、そこで定義された値はログと receipt から伏せられます。
追跡されているファイルは平文の設定として、そのまま扱われます。
宣言することも、別のファイルへ手で写すこともありません。

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

- named capture(`{name:string}`)は、値を名前で `args.name` に結び付けます。位置キャプチャでは、同じ型の値 2 つを pattern 内で入れ替えると、どちらの値がどこに入るかが黙って入れ替わります。`nuka check` は、それが起きる前に、裸の `{string}` もエラーとして検出します。
- `args` と `returns` は、実行境界でバリデーションされる zod のスキーマです。receipt の `result` は、step が返しただけのものではなく、ツールがバリデーション済みのものです。
- 上の `ctx.request()`(そして browser の step 向けの `ctx.page()`)が返すのは Playwright 自身の `APIRequestContext` と `Page` のオブジェクトであり、nukadoko 独自のラッパーではありません。そのため既存の Playwright の知識とヘルパーはそのまま持ち込めます。
- `nuka do create-project --args '{"name":"acme"}'` は、この 1 step だけを実行して receipt を出力します。agent の探索ループが成り立つ最小単位で、他に何も用意する必要がありません。

## What it fixes

**何を直すのか**

どの行も、文と実行のあいだの対応づけがかつて緩んでいた場所です。
cucumber-js を引き合いに出しているのは、そこが最もなじみ深い場所だからであって、それだけがこの緩みを持つ層だからではありません。

| The failure | What nukadoko does about it |
|---|---|
| 重複する step(どれが一致したか分からない) | `nuka check` は、何かが実行される前に、同じテキストが 2 回登録されている **duplicate patterns** と、feature の 1 行に異なる 2 つの pattern がどちらも一致し得る **ambiguous steps** を報告します |
| `this.foo`(型のない袋) | step は `returns` スキーマに対して値を返し、後続の step はそのうち 1 つのキーを名前で読むために `from` を宣言します。この依存関係は diff 上で見える import として現れ、読んだ事実は読み手側 step の receipt に記録され、束縛の順序が壊れていれば `nuka check` が実行前に検出します(参照: [Chaining steps](docs/spec.md#chaining-steps)) |
| `passed` としか言わない報告 | あらゆる実行が、バリデーション済みの result、ツール自身が観測したネットワークの読み書き、evidence、environment、target version を記録した receipt を書きます |
| 実行時に見つかる undefined な step | `nuka check <feature>` はそれらを実行前に静的に検出して失敗し、何にも一致しなかったテキストの名前を挙げます |
| 黙って状態を変える `Then` | `mutates` は nukadoko が信頼する宣言であり、計測から導き直す数値ではありません。`mutates: true` を宣言した step は、read-only な environment では実行前に拒否され、`Then` に結び付けられていれば `nuka check` が警告します。実際に何が起きたかは、レビューのためにいまも receipt に記録されます。 |

最後の項目は正確に言う価値があります。
このツールはかつて、約束ではなく計測された回数に対して失敗しており、それは言い過ぎでした。
書き込みの検出は HTTP メソッドに基づいており、これは GraphQL、RPC-over-POST、そして純粋な読み取りを POST の上に実装するベンダーの query API では破綻するプロキシです。
そうしたものを呼ぶ正直な `mutates: false` の step は、それでも書き込みとしてカウントされてしまいます。
一般的な HTTP レイヤーのルールでは、それを本物の書き込みと区別できないからです。
そこで nukadoko は代わりに宣言を信頼します。
実行が自分自身の request context と page を通じて実際に行った非 GET な呼び出しはいまも数えますが、その回数はもはや判定ではなく receipt 上の記録です。

## Reports fill themselves

**レポートはひとりでに埋まる**

従来型の Cucumber の実行がレポートに映す evidence は、チームが自分で仕込んだものです(trace やスクリーンショットのための hook の boilerplate を、プロジェクトごとに書いて保守しています)。
[Allure](https://allurereport.org/) はテストレポートのダッシュボードで、nukadoko はその形式で結果を emit するだけで、HTML 自体は決してレンダリングしません。
emitter は、何も仕込まずに、あらゆる receipt からレポートを満たします。
バリデーション済みの result、trace、HTTP log、observed な読み書き、environment と version です。
その中の 1 つ(バリデーション済みの per-step result)は、レポート側のどんな努力を積んでも足せません。
従来型の Cucumber は step の返り値を捨ててしまうからです。

あわせて cucumber-messages(NDJSON)の emitter も同梱されており、移行するチームの既存フォーマッタと JUnit ベースの CI をそのまま動かし続けます。
これは単なる主張ではなく、自前のストリームを `@cucumber/junit-xml-formatter` に通して確認済みです。
[Allure emitter](docs/spec.ja.md#allure-emitter) と [Messages emitter](docs/spec.ja.md#messages-emitter) を参照してください。

nukadoko が書くのは結果であって HTML ではないため、それを描画するのは Allure 3 の CLI です(`npm i -g allure`、または以下のように `npx allure`)。

```sh
R=.nukadoko/allure-results
npx allure watch $R --output .nukadoko/allure-report     # live, re-renders as a run writes
npx allure generate $R --output .nukadoko/allure-report
npx allure open .nukadoko/allure-report                  # serve one already generated
```

どれにも `--output` を渡してください。
Allure はこれを省くとカレントディレクトリの `allure-report/` を既定にし、`watch` もそこへ書き込みます。
つまり既定のままでは、レポートを見ただけで、追跡もされず ignore もされていない生成物がリポジトリのルートに残ります。
`.nukadoko/` の下へ出せば、`nuka init` がすでに gitignore に入れた場所に収まります。

反復しながら書いている間に使うのは `watch` です。
片方の端末で走らせたまま、もう片方で `nuka run` すると、scenario が着地するたびにレポートが更新されます。
待ち受けるポートはランダムです(`--port` で固定できます)。
`--open` を渡さないかぎり、ブラウザが開くことはありません。
`nuka init` は `.nukadoko/allure-results/` をあらかじめ作るので、最初の `nuka run` より前から `watch` を起動しておけます。

`allure-results/` は追記のみで、nukadoko がそれを消すことはありません。
そのため、自分でディレクトリを削除するまでレポートには毎回の実行が積み重なります。
新しい launch を始めたいときも、その削除が方法です。

## Self-healing, with the deviation on the record

**自己修復、ただし逸脱は記録に残す**

スクリプト化された scenario が壊れるのは、アプリが変わったからであり、テストが間違っていたからではありません。
nukadoko が作られているのは、この修復のループのためです。

1. agent は `nuka do` を使い、1 step ずつ各 receipt を読んで次の呼び出しを決めながら、目標を適応的に再実行します。
   壊れた scenario をそのまま再生しているのではなく、いま何が通用するのかを見つけ出しているのです。
2. それらの receipt は、実際にうまくいった手順を記録します。
   それは定義上、スクリプト化されたものから逸脱しています。
   receipt は修復の物語であり、証明ではありません。
   agent は PR の中で、それらをまさにその物語として引用します。
3. PR は型付き step または feature ファイルを更新し、その証明となるのは修復された scenario が green で通ることです。
   すなわち scenario の記録とその receipt であり、他のどんな変更とも同じようにレビューされます。

要点は手順 2 です。
**監査証跡のない self-healing は、スイートが気づかないうちに何もテストしなくなる仕組みそのものです。**
アプリがいま実際に何をしていようと、それに合わせて静かに書き換えられた scenario は、そのまま通り続けます。
そして、かつてそれが確認していたはずのものが失われたことに、誰も気づけません。
ここでは逸脱が、レビュアーが読む記録であり、証明は常に scenario を通り、ad-hoc な一連の呼び出しを通ることは決してありません。

nukadoko の貢献は、すべての段階が記録を残すことです。
執筆は agent のワークフロー(この下で扱う、同梱の skill)であり、エンジンの魔法ではありません。
詳しくは [Self-healing, audited](docs/spec.ja.md#self-healing監査付き) を参照してください。

このループが**捕まえられない**のは、スイートが空洞化するもう一つの経路です。
scenario 自体はそのままに、その `Then` が静かに弱くなっていくというものです。
receipt が記録するのは実行が何をしたかであって、assertion がいまも何かを意味しているかどうかではありません。
その部分はレビューに委ねられたままであり、[What this does not do](#what-this-does-not-do) がそのことをはっきり述べています。

## Skills for coding agents

**コーディング agent のための skill**

nukadoko は [Agent Skills specification](https://agentskills.io/specification) に従う 2 つの skill を同梱しており、Claude Code、Copilot、Cursor、Codex、Gemini CLI のどれからでも読み込めます。

- **acceptance** はチケットの受け入れ基準を、コミットされた記録まで運びます(語彙を読み、欠けているものを scaffold し、feature を書き、green になるまで実行し、`nuka accept` します)。
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

既存の Cucumber + Playwright スイートの移行経路は、import を 1 つ切り替えることです。
`@cucumber/cucumber` の代わりに `nukadoko/compat` を使い、同じ pattern の構文、hooks、World をそのまま動かしながら、その裏で nukadoko の harness が receipt の計測を始めます。
step を `defineStep` に昇格させるかどうかは、そこから先は書き換えではなく step ごとの判断になり、半分だけ昇格したスイートもそのまま通り続けます。

扉はスイートが入ってくる場所であって、留まる場所ではありません。
compat の step は evidence と `observed` の件数を新たに得ます。
それは、それまで持っていなかったものです。
けれども return 値は捨てられ、receipt は `result: null` を記録します。
バリデーション済みの result より先にあるものは、すべて手の届かないところに残ります: `nuka check` が feature を突き合わせる契約はなく、依存関係を宣言する `from` もなく、sign-off が述べるのは「step が実行された」ことであって「述べられた契約が保たれた」ことではありません。
それらこそが昇格させる理由であり、昇格させることがこの扉の目的です。

import を元に戻せば、ただの cucumber-js スイートに戻ります。
これは変わらない設計上の規則です(compat の資産は、切り替えにも部分的な移行にも耐えなければなりません)。
その役目は、nukadoko を試すコストを、大きな決断ではなく編集 1 つ分にすることです。
それは戦略を組み立てるための性質ではありません。
`defineStep` に昇格させた step には、切り替えて戻す import がありません: `run` は Playwright 自身のオブジェクトに対して書かれているため body は移りますが、そのスキーマとその上に組まれたものは移らず、ここには元に戻す手段は何もありません(手作業での道筋は docs/migration.ja.md の「戻り道」に書いてあります)。

他に何がどれだけ変わるかは、推測ではなく実測しました。
公開されている cucumber-js のスイート 8 本について、glue をこの扉に対してテキストとして読んだだけで、実行はしていません。
監査を行った時点で **import だけで通ったものはゼロでした**。
監査が見つけた障害をふさいだことで、8 本のうち 2 本はその後、glue の中に拒まれるものが何もない状態になりました。
残る 6 本は、先に短い機械的な準備が必要で、どの障害も、スイートの振る舞いを静かに変えるのではなく、import の時点か最初の実行でうるさく失敗します。

障害の 1 つは先に名指ししておく価値があります。
それは通過ではなく go/no-go だからです。
**CommonJS のスイートは、この扉をまったく使えません。**
`require("nukadoko/compat")` は、nukadoko が ESM 専用であるため、端的に失敗します。
つまり CommonJS のスイートには、他の何より先にモジュール形式の変更が必要です。
監査した 8 本のうち 2 本は、全体が CommonJS でした。

手順を追ったガイド(監査結果を収録)は [docs/migration.ja.md](docs/migration.ja.md) を、最後まで動く実例は [examples/migration](https://github.com/meganemura/nukadoko/tree/main/examples/migration) を参照してください。

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
   not, whether the suite is CommonJS, and where secrets currently live
   relative to where nukadoko expects them.
5. Verdict — adopt / trial / not-yet, with the reasoning.

Do not guess at nukadoko internals beyond what its README and docs/spec.md
state. If something is unclear, not yet implemented, or you don't have
access to a document you need, say so rather than assuming.
```

</details>

## Running this in CI

**CI で実行する**

`nuka check` と `nuka run` はどちらもスクリプトから呼べます。
すべてが保たれていれば `0` で終了し、何かが壊れた瞬間に非ゼロで終了するので、どちらもパイプラインへ普通の 1 step としてそのまま組み込めます。

```yaml
# excerpt from a CI workflow
- run: npx nuka check              # PR gate: static, seconds, no browser
- run: npx nuka run features/      # merge/deploy gate: executes, writes receipts
```

`nuka check` はあらゆる PR に置いてください。
安価なゲートであり、何かが実行されるより前に落とせます。
`nuka run` は、実際に真でなければならないゲート、すなわち merge や deploy の側に置いてください。
実行して receipt の証跡を残すのはこちらだからです。

**リトライは恒久的にスコープ外であり、「いまはまだ」ではありません。**
green な scenario は、その待ちが正しい場所に置かれている証拠には一切なりません。
scenario が必要としたあらゆる待ちは、もっと下流のどこかに偶然置かれていても供給され得たものであり、それらを一切通らない経路だけが、待ちが本来どこに属するかを示せます([Design](#design) を参照)。
receipt の `polls` フィールドは、すでにそれを正直に保っています。
即座に返った 1 回の試行と、20 秒待ち続けた 40 回の試行とを区別します。
step 全体を通るまで再実行するリトライは、green な実行を買うためにその区別を捨ててしまいます。
receipt が実際に起きた実行の記録であるこのツールでは、「3 回目で通った」は、その記録が述べられる事実ではありません。

並列実行とシャーディングは、今日の時点では実装されていません。
これは恒久的な制限ではなく「いまはまだ」であり、どちらも実装は可能で検討中です。
上のリトライとは違います。

## What this does not do

**これがやらないこと**

- **Receipts は偽造不可能ではありません。** shell アクセスを持つ agent は、receipt を含めどんなファイルでも書けます。これは secrets と同じ、正直な限界です。nukadoko がなくすのは、agent の **説明** を信頼する必要そのものです。実行と計測はツール側にとどまり、それを語る agent 側にはありません。
- **assertion が何かを本当に assert しているかは検査しません。** ある step がその description の主張どおりに正直に動くかどうかは、PR レビューに委ねられます。ツールが保証するのは入出力の形と実行された事実だけです。型付きの契約は、空の assertion をレビューで見つけやすくしますが、それを自動的に拒むものは何もありません。
- **`mutates` は信頼される宣言であり、network が示す内容から導き直されるものではありません。** 書き込みの検出は HTTP メソッドに基づいており、これは書き込みの意味論そのものではなく、そのためのプロキシです。純粋にクライアント側だけの状態や、GET で mutate してしまうサーバーは、これでは見えません。一方で、意味的には純粋な読み取りを POST 上に実装している step(GraphQL、RPC-over-POST、多くのベンダーの query エンドポイント)は、一度も行っていない書き込みとしてカウントされてしまいます。この 2 つのケースを一般的な HTTP レイヤーのルールで区別することはできません。だからこそ nukadoko は、その回数で step を失敗させるのをやめました。詳しい議論は [キーワードの意味論](docs/spec.ja.md#キーワードの意味論) を参照してください。その回数はいまも receipt と Allure に記録されるため、誤った `mutates` の宣言は事後に反証可能です。判断を担うのは宣言とレビューです。
- **CommonJS のスイートは、先にモジュール形式を変えない限り `nukadoko/compat` を使えません**(上記)。
- **CI レポーティングと HTML のレンダリングは組み込まれていません。** レンダリングを担うのは Allure のダッシュボードです(上記)。CI で何が動き何が動かないか、なかでもリトライだけが計画されていない理由は、[Running this in CI](#running-this-in-ci) で扱っています。

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
凍結された result が、その step の現在のスキーマをもはや通らない sign-off。
その記録はいまも数えられ続けながら、もはや自分が述べている内容を言い表していません。
何にも行使されない `from` 宣言。
description のないスキーマフィールドは、ファイルを見る人にはそれで問題なく読めても、2 つの step のどちらかを選ぶ agent には何も伝えません。
そのどれも run を止めはしませんが、だからこそどこか他の場所で言われる必要があったのです。
あらゆる run の前に出力されていたら、本当に止めるべき行までみんなが読み飛ばすことを覚えてしまうでしょう。

これは、床がいまどこにあるか(語彙のうちどれだけが、まだ compat のままではなく型付きになっているか)から始まります。
それは、その数がこれまで receipt のディレクトリを読むことでしか見えず、そんなことをする者は誰もいなかったからです。

## Design

**設計**

設計の全体、すなわち課題設定、型付き step、キーワードの意味論、receipt、session/environment/secret、sign-off、roadmap、正直な限界は、1 か所にまとまっています: [docs/spec.ja.md](docs/spec.ja.md)。

English: [README.md](README.md) / [docs/spec.md](docs/spec.md)

## License

**ライセンス**

[MIT](LICENSE)
