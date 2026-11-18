# nukadoko の TypeScript 版

[![npm version](https://img.shields.io/npm/v/nukadoko?logo=npm)](https://www.npmjs.com/package/nukadoko)

[nukadoko](https://github.com/meganemura/nukadoko/blob/main/README.ja.md) の TypeScript のエンジンです。
Gherkin のステップに TypeScript で型付きの契約を付け、シナリオのまちがいを実行前に見つけます。
Ruby 版と同じ feature ファイルを読み、同じ判定を返す必要があります。
[`conformance/`](https://github.com/meganemura/nukadoko/blob/main/conformance/README.md) のケースがそれを確かめます。
feature ファイル、クレーム、実行、ステップ記録、判定が何かは両方のエンジンで同じです。
それは[プロジェクトの README](https://github.com/meganemura/nukadoko/blob/main/README.ja.md) と[ドキュメントサイト](https://meganemura.github.io/nukadoko/ja/)に一度だけ書いてあります。
このページには TypeScript 版だけに要ることを書きます。
インストールのしかた、ステップの書き方、コマンドが足すものです。

## インストール

Node は 22 系なら 22.18 以上、または 23.6 以上が要ります。
フラグなしで `.ts` ファイルを実行できるリリースです。
nukadoko は config とステップのファイルを Node 自身の型の除去で読み込むので、TypeScript のローダーを自分では入れません。

```sh
npm install -D nukadoko
```

ブラウザは入れません。
Playwright は任意の peer dependency で、`page` か `request` を使うステップだけが必要とします。

```sh
npm install -D -E playwright@1.63.0
npx playwright install chromium
```

peer の範囲は `^1.61.1` なので、すでに新しい Playwright 1.x を使っているプロジェクトはそのバージョンのままで使えます。
入っていないときは、何かを実行する前に `nuka check` がそのステップとこのインストールのコマンドを示します。
ほかのコマンドは `tsc` も含めてすべて動きます。
Playwright を入れるまで、`page` と `request` の型は `any` です。

`npx nuka init` は `nukadoko.config.ts`、空の `features/steps/`、`.nukadoko/` と `.env` ファイルの `.gitignore` の行を書きます。

## ステップ

`features/steps/` の下に 1 ファイル 1 ステップで書きます。
ファイル名がステップ名です(`an-item-exists.ts` は `an-item-exists`)。

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

- `args` と `returns` は zod のオブジェクトです。
  `z` は `nukadoko` から再エクスポートされるので、プロジェクトが zod を自分で入れる必要はありません。
- `run`(Then ステップでは `observe`)の第 1 引数は分割代入し、受け取る名前がそのステップの要るフィクスチャです。
  `nuka check` は本体を呼ばずにそれを読みます。
- `from: { body: [createItem, "body"] }` は、前のステップが返した値で args のキーを埋めます。
  ステップは import するので、名前を変えると型エラーになります。
- Then ステップは `claims` と、世界を読む `observe` を宣言します。
  クレームは nukadoko が判定します。
- `nukadoko.config.ts` の `defineFixtures` はプロジェクトのフィクスチャを足し、`use()` は後片付けの始まりを示します。

## コマンド

コマンドは Ruby 版と同じです。
片方のエンジンにだけあるフラグは、[プロジェクトの README の表](https://github.com/meganemura/nukadoko/blob/main/README.ja.md#install)にあります。
今この版にだけあるものは次のとおりです。

- `nuka check --codes` はすべての指摘のコードと意味を並べ、`--fail-on <code>` は注意を検査の失敗にします。

## 開発

このエンジンはリポジトリの `typescript/` にあります。
準備とコマンドは [CONTRIBUTING.md](https://github.com/meganemura/nukadoko/blob/main/CONTRIBUTING.md) にあります。

[English](README.md)
