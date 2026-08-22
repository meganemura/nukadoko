# 第二の扉: Playwright Test のスイート

> 原文は migration-playwright-test.md。相違があれば原文が正。

まだ cucumber-js も Gherkin も使っていないプロジェクト向けです。
Playwright Test に対して直接書かれたスイートには、差し替える import そのものがありません: そのテストは `test("...", async ({ page }) => {...})` であり、リダイレクトする glue レイヤーもありません。
[docs/migration.ja.md](migration.ja.md) はもう一方の扉、cucumber-js から始まる扉を扱っています。
そちらがあなたのスイートでなければ、ここから始めてください。

nukadoko 自身のインストールと設定は、どちらの扉を使っても同じであり、その手順のどこにも cucumber 固有のものはありません。
パッケージをインストールし、プロジェクトルートから `nuka init` を実行してください。
フラグの一覧は `nuka init --help` が表示します(`--base-url` と `--features-dir` を含みます)。
`nuka init` は `nukadoko.config.ts` を書きます:

```ts
import { defineConfig } from "nukadoko";

export default defineConfig({
  featuresDir: "features",
  baseURL: "http://localhost:...", // wherever the app under test listens
});
```

Playwright Test のスイートはすでに自分自身の `baseURL` を持っています。
`playwright.config.ts` の `use.baseURL` です。
これは別のフィールドであり、nukadoko はそれを一切読みません。
そのため同じ値を両方のファイルに書くことになります。
ここではその重複を解消しません。
2 つの設定が今そういう関係にある、というだけです。

`nuka run` も `nuka do` も `playwright.config.ts` を一切読まないため、その `webServer` フィールドは決して動きません。
`playwright test` はそのフィールドを通じて、spec を 1 つ実行する前にテスト対象のアプリを起動しますが、この 2 つのコマンドはそうしません。
アプリがまだ待ち受けていない状態で `request` や `page` を呼ぶ step は `ECONNREFUSED` で失敗します。
先に自分の手でアプリを起動してください。

## 共有するのは runner ではなく実装

既存のスイートには差し替える import がないため、この扉は別のやり方で動きます。
ある操作が spec ファイルの外に移り、Playwright 自身のオブジェクトだけを受け取る、ただの非同期関数になります。
spec はそれを呼びます。
型付き step の `run` もそれを呼びます。
どちらの runner も、もう一方のファイルを読み込むことは決してありません。

```
e2e/cart.spec.ts  ──▶  e2e/lib/cart.ts  ◀──  features/steps/add-item.ts
   (Playwright)          (plain functions)          (nukadoko)
```

矢印は意図的に一方向です。
Playwright のスイートは nukadoko を一切 import しないため、この移動のあとにそれが依存するものは、移動の前に依存していたものとまったく同じです: Playwright と、自分自身のリポジトリにある関数です。
そのため、この扉の戻り道は compat の扉の戻り道より強力です。
compat の扉を戻すとは import を元に戻すことであり、この扉を戻すとは feature ファイルと step ファイルを削除することです。
削除したあとのスイートが無傷のままなのは、そこが使うものがどれも nukadoko の存在を一度も知らなかったからです。

共有を成立させているのは約束ではなく形です: `page`、`context`、`request`、`baseURL` はどちら側でも Playwright 自身のオブジェクトであり(docs/spec.ja.md の「Context API」を参照)、それらに対して書かれた関数はすでにどちらからも呼び出せます。
何も変換されず、ラップされず、re-export もされません。

## あえて共有しないもの

意図的に共有しないのは、その一線より上にあるものすべてです。
spec は `step.run(bag, args)` を直接呼んではいけません。
これは誘惑的に見えますが、成り立つのはその step が Playwright だけの名前を分割代入している間だけです: その step が `call`、`section`、`resultOf`、`requireEnv` のどれかに手を伸ばした瞬間に壊れ、それはその step が持つ価値を持ち始める瞬間でもあります。
fixture map も同じく共有できません。
その型づけ上の理由は docs/spec.ja.md の「Fixtures」がすでに挙げています。

## 契約は両側とも 1 つ

契約は、その一線より上にではなく共有ユニットの側に置くことができ、そう置くべきです。
step の `args` と `returns` はただの zod スキーマなので、その関数自身のファイルがそれらを export し、step 側はそれを宣言できます:

```ts
// e2e/lib/cart.ts
export const openCartReturns = z.object({ id: z.string() });
export async function openCart(request: APIRequestContext) { ... }

// features/steps/open-cart.ts
export default defineStep({
  patterns: ["a cart is opened"],
  description: "Open a new cart",
  args: z.object({}),
  returns: openCartReturns,
  run: ({ request }) => openCart(request),
});
```

定義は 1 つだけで、両方の住まいからそれを import するので、spec と step が形について食い違う方向へずれることはありません。
共有ファイルが依存するのはあくまで Playwright と zod だけなので、上の矢印は変わりません。

## 値の出どころを名指す: `from`

`from` は、pattern がキャプチャしなかった args キーの値がどこから来るかを宣言します(docs/spec.ja.md の「step の連鎖」を参照)。
上流の step と、その step の `returns` のどのキーを読むかです。

```ts
// e2e/lib/cart.ts (continuing the file above)
export const addItemArgs = z.object({ cartId: z.string(), sku: z.string() });
export const addItemReturns = z.object({ itemId: z.string(), cartId: z.string(), sku: z.string() });
export async function addItem(request: APIRequestContext, cartId: string, sku: string) { ... }

// features/steps/add-item.ts
import openCartStep from "./open-cart.js";

export default defineStep({
  patterns: ["item {sku:string} is added to the cart"],
  description: "Add one item to the cart opened earlier in this scenario",
  args: addItemArgs,
  returns: addItemReturns,
  from: { cartId: [openCartStep, "id"] },
  run: ({ request }, args) => addItem(request, args.cartId, args.sku),
});
```

`from` は、上流の step を import することでそれを名指します。
値が他のどのモジュールに入るときとも同じやり方です。
上の `openCartStep` は `open-cart.ts` 自身の default export です。
`from` の値は常に `[<step>, "<キー>"]` です。
値を生み出す step と、その step 自身の `returns` のどのキーを読むかの組です。
キャプチャにも自分自身の名前が要ります。
`{sku:string}` であり、cucumber の裸の `{string}` ではありません。
`nuka check` は名前のない形を `unnamed-capture` として拒否します。
`from` はどのキャプチャも届かなかったキーを埋めるものです。

これは `use` が必要とするものでもあります。
`nuka do --use <record-id>` と、`experimental_recordStep` 自身の `use` オプション(後述)は、どちらも先行する step record の結果から step の `from` キーを埋めます。
上流の step を名指す `from` エントリを持たない step には `use` が埋めるものが何もなく、黙って無視されるのではなく拒否されます。

## Playwright の実行を record に変える: `experimental_recordStep`

実装を共有するだけでは record は生まれません。
Playwright の run が残すのは Playwright 自身の成果物だけで、step record は残りません。
step record を書くのは executor であり、その home にはそれがないからです。
既存のスイートは、実装のすべての行を共有していてもなお、harvest できるものを何も残さないことがあります。

`experimental_recordStep` は nukadoko 自身から export されており、この隙間を閉じます。
experimental という名前が付いているのは意図的で、誰もそこに偶然たどり着かないようにするためです。
この印が外れる条件は、いまは 1 つだけ残っています。
この API の形が、nukadoko 自身のテストだけでなく、本物の Playwright Test スイートに対して変更なしに動いた実績です。
`request` だけでなく注入された `page` にも、すでに対応しています。
fixture が browser に手を伸ばす step が拒否されるのは、呼び出しが `page` を渡さないときだけです。
`rootDir` は、`nuka do`/`nuka run` にとっての `nukadoko.config.ts` と `.nukadoko/` が住むのと同じプロジェクトルートです。
Playwright Test の spec の中では、たいてい `process.cwd()` がそれに当たります。

```ts
const opened = await experimental_recordStep(
  openCartStep, {}, { name: "open-cart", rootDir, request },
);
const added = await experimental_recordStep(
  addItemStep, { sku }, { name: "add-item", rootDir, request, use: [opened.stepRecordId] },
);
```

**次の呼び出しへ渡すのは record の id であり、返ってきた値ではありません。**
spec は直前の結果を変数に保持して次へ渡すのが自然な書き方です。
けれどもそう書くと連鎖は何も記録されません、実際には連鎖していないからです。
連鎖したと言う手段が `use` であり、意味は `nuka do --use` とまったく同じです。
`use` を省くと、そのキーは呼び出し側が渡したものとして読まれます。
すると `nuka harvest` が書く下書きにはその実行自身の id がそのまま載り、それをまだ覚えているサーバでは通り、新しいサーバでは失敗します。
その失敗は原因となった実行からずっと後になって現れるので、最初から正しくしておく価値があります。

step は spec 自身の `request` に対して実行され、そのスキーマは強制され、step record は `nuka do` の record と同じ場所に置かれます。
だから、チームがすでに実行しているスイートが record の供給源になり、そこにすでにコード化されている道のりは `nuka harvest` を通じて下書きになります: 書き直すのではなく実行することによる移行です。

3 つの性質が、それによって record の意味がぼやけてしまうのを防ぎます。
record は `kind: "external"` を記し、これは実行がどう起きたかについて `do` と `run` に並ぶ 3 つ目の答えなので、人が手で打ったものとして読まれることはありません。
`harvest` はそれを受け入れますが、すでに feature を持つ `run` の record を拒否し続けます。
注入された request context は、他のどの request と同じログと redact を受けるためにラップされますが、破棄されることは一切ありません。
別の所有者が開けたものを閉じるのは、2 回目の呼び出しで初めて表に出る不具合だからです。
そして、fixture が browser に手を伸ばす step は、呼び出しが `page` も渡さない限り、record が存在するより前に拒否されます。
どちらの場合も、この経路が自分から browser を起動することはありません。

それでも渡れないままなのが sign-off です。
`nuka accept` が必要とするのは green なフル実行の `nuka run` とその scenario record であり、external な record はそれではありません。
このツールが保証するのは自分自身が駆動した実行についてであり、自分が駆動しなかった実行については、誰かの言葉を受け取ることしかできません。
だから external な record は、`do` の record とちょうど同じ意味で作業記録です: scenario が harvest される素材であり、決して evidence ではありません。

## 1 つのリポジトリに 2 つの木

nukadoko 自身の 2 つの経路がどちらも同時に開き、それこそが書き直すのではなくここから入る意味です。
`nuka run` は feature ファイルの中に経路を固定し、`nuka do` はそのどの step も単独で実行できるので、既存のスイートがすでに信頼している同じ操作が、agent が探索するときの語彙になります(参照: docs/spec.ja.md の「単体 step」と「Live sessions」)。

2 つの木は 1 つのリポジトリに同居でき、どちらの配置でも動きます。
並べて置くのが分かりやすい方です。
もう一方は名指す価値があります。
Playwright のスイートを資産とするチームにとって要求が小さいからです: `featuresDir` を、spec がすでに住んでいるディレクトリの内側に置きます。

```
e2e/
  cart.spec.ts          <- Playwright finds this
  lib/cart.ts           <- shared, owned by neither runner
  nukadoko/             <- featuresDir
    cart.feature
    steps/add-item.ts   <- Playwright does not find this
```

これが成り立つのは、それぞれの runner が自分の認識するものしか読み込まないからです。
Playwright は自分自身の `testMatch` にマッチするファイルを集めますが、自分が定義する step にちなんで名付けられた step ファイルがそれにマッチすることは決してありません。
discovery は `featuresDir` の下にある `.ts`/`.mts`/`.js`/`.mjs` をすべて import しますが、その外に留まる spec がそこに含まれることは決してありません。
この 2 つの規則は命名と配置についてのものであり、互いに衝突しません。

間違え方は 2 つあり、どちらも黙っては終わらず捕まります。
`featuresDir` の内側にある spec は discovery に import されますが、Playwright の `test()` は自分自身の runner の外から呼ばれることを拒否するので、そのファイルは import に失敗します。
`nuka check` はこれを、docs/migration.ja.md で名指されているのと同じ `step-file-import-failed` のコードで報告し、今回は Playwright 自身のエラーメッセージを運びます。
`run`/`do` も、他の壊れた glue に対してとまったく同じように、実行そのものを拒否します。
spec のように名付けられた step ファイルは、また別の形でぶつかります。
step の名前はそのファイルの basename なので、`open-cart.spec.ts` は最初の step と同じ pattern を持つ、`open-cart.spec` という 2 つ目の step を定義してしまい、`nuka check` はその両方を名指しして `ambiguous-step` を報告します。
1 つの pattern が 2 つ以上の step にマッチしていることがそのエラーであり、直すのはファイル名です。

共有ファイルは、どちらの配置でも `featuresDir` の外に属します。
discovery がそれを import しても害はありません。
step を 1 つも定義しないモジュールは単に語彙ではないからです。
それでも配置は誰がそれを所有するかを語っており、所有するのは既存のスイートです。

## 戻り道

feature ファイルと step ファイルを削除すれば、Playwright のスイートは無傷のままです。
これは「共有するのは runner ではなく実装」で述べたのと同じ約束です。
使っているものが nukadoko を一度も import していないからです。

戻るときに気に留めておくべき唯一の例外が `experimental_recordStep` です。
これを spec ファイルから直接呼んでいる場合、そのファイルには `import { experimental_recordStep } from "nukadoko"` という行が実際に書かれています。
そのスイート自身の実行を record に変えるためにその呼び出しを足していたなら、それを取り除くことも同じ戻り道の一部です。
feature ファイルと step ファイルと一緒にその呼び出し箇所も削除すれば、nukadoko を知っていたものは何も残りません。
