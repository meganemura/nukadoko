# cucumber-js + Playwright スイートの移行

> 原文は migration.md。相違があれば原文が正。

既存の cucumber-js スイートを Playwright に対して実行しているチーム向けで、feature ファイルと step の定義は `features/` 配下にあります(cucumber-js 自身のレイアウト規約であり、nukadoko のデフォルトでもあります)。
書き換えは不要です: 目標は、スイートを変更せずに nukadoko の harness 上で実行し、その後は自分のペースで一部ずつ昇格させることです。
以下の各段階の実際に取得したコマンド出力を伴う完全な実例については、[examples/migration](../examples/migration/README.md) を参照してください。

## Stage 0: nukadoko をインストールしてスイートに向ける

nukadoko をインストールし、プロジェクトルートから `nuka init` を実行します(あるいは `nukadoko.config.ts` を手書きします):

```ts
import { defineConfig } from "nukadoko";

export default defineConfig({
  baseURL: "http://localhost:...", // wherever the app under test listens
  featuresDir: "features",         // point this at your existing features/
});
```

`nuka init` は `nukadoko.config.ts` が既に存在する場合は実行を拒否し、`<featuresDir>/steps/` を作成し、`.nukadoko/` を `.gitignore` に追加し、(まだ空の)語彙を発見する self-check で終わります。
`featuresDir` はデフォルトで `features`(cucumber-js 自身の規約)なので、ほとんどのスイートは上書き不要であり、discovery はディレクトリ全体をたどるため、その配下の別の場所にある step ファイル(`features/step_definitions/`、`features/support/`)も並べ替えは不要です。

## Stage 1: import を差し替える

step ファイルが使っている import を 1 つ差し替えます:

```ts
// before: import { Given, When, Then } from "@cucumber/cucumber";
import { Given, When, Then } from "nukadoko/compat";
```

その import より下は、変更せずにそのまま動き続けます:

- string と RegExp の pattern は、cucumber-js が一致させるのとまったく同じように一致します(named capture は要求されません。その規律は typed step のものです)。
- `World`(`this`)、単一の `@tag` または `not @tag` でフィルタされる `Before`/`After` フック、カスタムの `setWorldConstructor` サブクラス。
- `DataTable`(`raw()`/`rows()`/`hashes()`/`rowsHash()`/`transpose()`)。
  `table.hashes()` を呼ぶ step は書いたとおりにそのまま動き続けます(摩擦ゼロで、examples/migration 自身のスイートを移行する形で計測済みです)。
- glue 内の `allure.*` 呼び出し(`attach`/`log`/`link`、ラベル、パラメータ)は、消えるのではなく receipt の `declared` フィールドに入ります。

静かに誤動作する代わりに大きな声で失敗するものもあります: `BeforeAll`、`AfterAll`、`setDefaultTimeout` は `nukadoko/compat` から一切 export されておらず、これらを import すると欠けている export の名前を挙げた即座のエラーになります。
単一の `@tag`/`not @tag` を超える hook のタグ式(`and`/`or`/括弧)も、`nuka run` した瞬間に同じように失敗します。

`nuka run features/your.feature` でスイートを実行します。
あらゆる step が receipt を得るようになり、それ以外に何かを変える必要はありません。

## 計測されるアップグレード(任意)

自前で Playwright のブラウザや request クライアントを起動する glue は、計測されないまま動き続けます(nukadoko は一切手を触れません)。
その bootstrapping を `await this.openPage()` / `await this.openRequest()` に置き換えると(混在 scenario の typed step と同じ context に委譲し、scenario ごとに 1 つのブラウザと 1 つのセッションです)、その step の receipt は他のコード変更なしに trace、`http.jsonl` log、`observed` の読み書き件数を得ます。

## Stage 1.5: 依存しているものを宣言する

互いに独立した、順不同で単独でも安全に行える 2 つの漸進的な一手があります:

- **World keys**: 依存しているキーを `defineWorld({ key: someZodSchema })` でラップして拡張します(`class MyWorld extends defineWorld({ seededCount: z.number() })`)。
  そのキーへの書き込みはこれで検証されるようになり(スキーマに失敗した書き込みは step を失敗させ、記録されません)、それ以外のすべてのキーは計測されるが検証されないまま動き続けます。
  `MyWorld` の `this` も、宣言されたキーについては型が付きます。
- **Parameter types**: support 側の `defineParameterType` 呼び出しは引き続き動きますが、`nuka check` が警告し(`parameter-type-support-origin`)、typed 時代の住まいとして `config.parameterTypes` を指し示します(登録を移してもどの pattern のマッチも変わりません)。

## Stage 2: step を昇格させる

consumer より先に producer を昇格させます: `this` にデータを溜め込んでいた step を `defineStep` にし、読み手は `this` を読む代わりに `ctx.resultOf(producerModule)` を通じてその結果を取得するようにします。
昇格した step は、型付きの契約、検証済みの `result`、`nuka do` による単体実行を得ます(そのどれも compat の step にはありません)。

## ダッシュボードは `nuka check`

`nuka check` は、移行がどれだけ残っているかを示す走行メーターです:

- `then-compat-step` は、compat の step が `Then` の位置に結び付けられていると警告します(compat の step には静的にチェックできる宣言上の `mutates` が無いため、これは実行時の観測だけが強制を担っている箇所を示します)。
- `parameter-type-support-origin` は、support 側の `defineParameterType` すべてに対して警告し、上記の config への移動を指し示します。
- receipt は実行時に同じ話を語ります: スイートがより多く typed step と `ctx.resultOf` に昇格するにつれて、`world`(compat の step のみ)と `declared` が縮んでいきます。

## 戻り道

これらはどれも一方通行ではありません。
import を `@cucumber/cucumber` に戻せば(`openPage()`/`openRequest()` が置き換えた Playwright の bootstrapping も元に戻せば)、スイートは再びただの cucumber-js スイートになります。

## 既知の限界

- hook 自身のネットワーク通信はどの step の境界にも属しません(どの step の `observed` にもカウントされません)。
- World の計測が見るのは World 自身の own データプロパティだけです。
  `#private` のフィールドは、構造上 `world.reads`/`world.writes` に現れません。
- 宣言された attachment のファイル内容は redact されません(trace や screenshot がすでに抱えているのと同じ正直な限界です)。
