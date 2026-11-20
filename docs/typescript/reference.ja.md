# TypeScript エンジン

> 原文は reference.md。

npm パッケージで step、fixture、config をどう書くかをまとめます。
feature ファイル、claim、run、record の意味はどちらのエンジンでも同じで、[spec](../spec.ja.md) に一度だけ書いてあります。
[Ruby エンジンのページ](../ruby/reference.ja.md) は同じ見出しを同じ順に並べているので、2 つを並べて読めます。

## インストールとコマンド

Node は 22 系なら 22.18 以降、それ以外なら 23.6 以降が要ります。
`.ts` ファイルをフラグなしで実行できる版です。
nukadoko は devDependency で、プロジェクトは `npx nuka` で実行します。

```sh
npm install -D nukadoko
npx nuka init
```

`init` は `package.json` に `test:scenarios` script も追加します。
人も CI も、この 1 つのコマンドを実行します。
`tsconfig.json` の `include` には steps と config を追加し、`.ts` ファイルを名指しする import を `tsc` が受け付けるためのコンパイラオプションも追加します。
CommonJS の場合と `--allure` フラグは [Setup details](../guide.ja.md#setup-details) にあります。

Playwright は省略できる peer dependency で、`page` か `request` を使う step だけが必要とします。

```sh
npm install -D -E playwright@1.63.0
npx playwright install chromium
```

## 設定

`nuka init` は `nukadoko.config.ts` を書きます。
default export は `defineConfig({ ... })` で、オプションを検査し、型を付けます。
各オプションは、それが決めるものと一緒に説明しています。
`program` と `fixtures` はこのページの下に、`featuresDir` と `parameterTypes` は [spec](../spec.ja.md) の「型付き step」にあります。

## step を定義する

`features/steps/` の下に、1 ファイルに 1 つの step を kebab-case の名前で置きます。
ファイル名が step の名前です。
default export は `defineStep({ ... })` です。

```ts
import { defineStep, z } from "nukadoko";
import assert from "node:assert/strict";

export default defineStep({
  description: "Create an item through the API so a later step can read it",
  pattern: "an item named {name:string} exists",
  args: z.object({ name: z.string().describe("The item's name") }),
  returns: z.object({
    id: z.number().describe("The id the API assigned"),
    body: z.object({ id: z.number(), name: z.string() }).describe("The item as the API answered it"),
  }),
  async run({ baseURL }, { name }) {
    const res = await fetch(`${baseURL}/items`, { method: "POST", body: JSON.stringify({ name }) });
    assert.equal(res.status, 201, `creating "${name}": status`);
    const item = (await res.json()) as { id: number; name: string };
    return { id: item.id, body: item };
  },
});
```

`mutates: false` は、何も変えない step であることを宣言します。
step ファイルは、別の step を `.ts` まで含めたファイル名で import します。
Node が型を取り除いて実行するので、`enum`、`namespace`、コンストラクタの parameter property は読み込めません([spec](../spec.ja.md#型付き-step) の「型付き step」)。

`nuka scaffold --command` が書く step は、エントリポイントを `node` そのもので実行します。
そのため、`.ts` ファイルどうしが `.js` の specifier で import し合うプロジェクトでは、エントリポイントはビルドした後のプログラム(たとえば `--command dist/cli.js`)で、`"pretest:scenarios": "npm run build"` があれば、clone した直後のチェックアウトでも green になります。
`.ts` のエントリポイントが import する `.js` ファイルがなく、その横に `.ts` ファイルがあるときは、scaffold が拒否します。

## フィールドとスキーマ

`args` と `returns` は zod の object です。
`z` は `nukadoko` から re-export しているので、プロジェクトが zod を入れる必要はありません。
`nuka describe` は各スキーマを `z.toJSONSchema` で JSON Schema にして出します。

## キャプチャ、テーブル、doc string

pattern の `{key:type}` は、args のキー `key` を埋めます。
データテーブルは `string[][]` として、doc string は `string` として、そのキーに届きます。

```ts
args: z.object({
  todos: z
    .array(z.array(z.string()))
    .describe("The data table's rows, one todo per row, the title in the first cell"),
}),
```

## Claims

Then の step は、`run` の代わりに `claims` と、世界を読む `observe` を宣言します。
各 claim は nukadoko が判定します([spec](../spec.ja.md#claims) の「Claims」)。

## 連鎖(`from`)

`from: { id: [startJob, "id"] }` は、`startJob` という step がこの scenario で先に返した値で `id` を埋めます。
step を import して書くので、名前を変えると型エラーになります。
`startJob.returns.shape.id` で、返す側のスキーマをそのキーに使い回せます。

## Parts

`parts: [createTodo, completeById]` は `run` が呼んでよい step を並べ、`await call(createTodo, { title })` はその 1 つを args と returns を検査しながら実行します([spec](../spec.ja.md#parts) の「Parts」)。

```ts
parts: [createTodo, completeById],
async run({ call }, args) {
  const created = await call(createTodo, { title: args.title });
  const completed = await call(completeById, { id: created.id });
  return { id: completed.id, done: completed.done };
},
```

## Fixtures

config の `defineFixtures` で、プロジェクトの fixture を足します。
fixture は、名前を挙げた fixture と `use` 関数を受け取り、`await use(value)` のあとが後片付けです。
組み込みと同じ名前の fixture は、すべての step でその組み込みに置き換わります。

```ts
import { defineConfig, defineFixtures } from "nukadoko";

export default defineConfig({
  fixtures: defineFixtures({
    page: async ({ page }, use) => {
      await page.addInitScript(() => {
        (window as unknown as { wrapped: string }).wrapped = "by the project";
      });
      await use(page);
    },
  }),
});
```

## Context

`run` と `observe` の第 1 引数は分割代入で受け、そこに書いた名前が step の必要とする fixture です。
名前は `page`、`context`、`pageAs`、`request`、`env`、`requireEnv`、`baseURL`、`scratch`、`section`、`poll`、`evidence`、`resultOf`、`call` です。
`nuka check` は本体を呼ばずにこの分割代入を読みます([spec](../spec.ja.md#context-api) の「Context API」)。
`scratch.dir()` は新しいディレクトリを返し、scenario が終わると消えます。

## ポーリングと待ち

Then の step の `poll: { timeout_ms: 3000, settled: [...] }` は、続けて 2 回読んだ値ですべての claim が成り立つか、時間が切れるまで、`observe` を読み直します。

## プログラム

テスト対象のプログラムは config の `program` で、プログラムの起動のしかたを返す関数です。

```ts
export default defineConfig({
  program: () => ({ serve: { command: "node src/server.ts", ready: "/items" }, env: { PORT: "{port}" } }),
});
```

フィールドは [spec](../spec.ja.md#テスト対象のプログラム) の「テスト対象のプログラム」にあります。

## Compat steps(移行の扉)

cucumber-js のスイートは、import を 1 つ `nukadoko/compat` に変えるだけで、step 定義をそのままにして取り込めます。
compat step の名前はパターンで(`compat: <pattern>`)、契約はなく、それぞれ自分の step record を持って動きます。
その hook はシナリオの World の上で動き、シナリオの record の `hooks` に 1 項目ずつ入ります。
扉が受け付けるものは [doors.ja.md](doors.ja.md) に、スイートを移す手順は [migration.ja.md](migration.ja.md) にあります。

## 型とツール

`tsc` が config と step を検査します。
`tsconfig.json` が `rewriteRelativeImportExtensions` も `allowImportingTsExtensions` も書いていなければ、`nuka init` が前者を足すので、`.ts` を含む import の名前が通ります。
`"erasableSyntaxOnly": true` にすると、Node が取り除けない書き方を `tsc` が拒みます。

## このエンジンにないもの

`nuka sig` は Steep のための RBS を書くコマンドで、Ruby エンジンにだけあります。
