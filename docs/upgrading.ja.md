# nukadoko のアップグレード

> 原文は upgrading.md。
> 相違があれば原文が正。

すでに nukadoko の上で動いているプロジェクトが、新しいリリースへ移る場合の文書です。
cucumber-js のスイートから来た場合は、代わりに [docs/migration.ja.md](migration.ja.md) を参照してください。
その扉と、このアップグレードは、別の読者に向けた別の問いです。

## 毎回のアップグレードの仕方

ここはリリースごとに変わりません。

- **完了条件は `nuka check` が green になることであり、`tsc` が通ることではありません。**
  step は `tsc` のもとで型として完全に正当なまま、`nuka check` に拒否されることがあります。
  例えば `run()` が分割代入されていない第一引数を取る step は、型検査は通りますが `check` には拒否されます。
  `check` は step の静的な形を、型システムより厳しく読むからです。
  `tsc` が通ることは、アップグレードを止めてよい合図ではありません。
  合図になるのは `nuka check` が green になることです。
- **`nuka steps` と `nuka describe` は、アップグレードの途中でも語彙を読めます。**
  1 つの step ファイルの import が失敗しても、どちらのコマンドも道連れにはなりません。
  discovery が読めたものはそのまま返り、読めなかったものは stderr と `import_failures` に名指しされます(`nuka steps --json` のトップレベルは素の配列ではなく `{ schema_version, steps, import_failures }` です)。
- **`needs_inferred` は、まだ誰も手を付けていない step からでも引けます。**
  `run()` が分割代入されていない第一引数を取ったままの step には、その引数自身のメンバアクセスから読み取ったベストエフォートの `needs_inferred` が付きます。
  アップグレードの途中で、fixture の棚卸しを手作業で組み立てる必要はありません。
- **`nuka check` の findings はまとめられ、繰り返されません。**
  複数のファイルに当てはまる finding(たとえば `step-file-import-failed`)は、メッセージを 1 回だけ出し、その後にソートされたファイル一覧を続けます。
  ファイルごとに繰り返しはしません。
- **順番**: パッケージを上げる → `nuka check` を実行する → 指摘を直す → `nuka run` を実行する → 両方 green になるまで繰り返す。
- **いくつものリリースをまたぐときは、自分のバージョンから上の節をすべて読み、新しい節を優先します。**
  下の各節は、そのリリースが出たときの姿を書いています。
  古い節が名指すコマンド、フラグ、終了コードは、後のリリースで削除されたり変わったりしていることがあります。
  最新のリリースでは、拒否は 2 で終了し、`nuka clean` は `--records`、`--cache`、`--export` を受け付けません。
- **下に節が無いリリースは、対応が要りません。**
  0.4.1、0.6.0、0.13.1、0.14.0 が、そのようなリリースです。
  自分のバージョンより上で終わる最初の節から読み始めます。
  たとえば 0.13.0、0.13.1、0.14.0 のプロジェクトは、「0.14.0 から 0.14.1 へ」から読み始めます。

## 0.21.0 から次のリリースへ

- **型付きの Then は claim を宣言し、コードを実行する Then はエラーになります。**
  `nuka check` は、Then の位置に結び付いた、実行する型付きの step を `then-without-claims` として報告し、それが報告されている間 `nuka run` は始まりません。
  それぞれについて、`run` を `claims` に置き換え、`returns` と `mutates` を削除します。
  `defineStep` は claim step でのそれらを拒否します。
  step が `from` を通して読んでいた値は `from` のキーのままです。
  step が自分で読んでいた値は `observe` に移し、`observe` は読んだものを返します。
  そのうえで、各期待値の出所を選びます(docs/spec.ja.md の「Claims」)。
  文が値を述べる場合:

  ```ts
  export default defineStep({
    pattern: "it exits with {code:int}",
    description: "The process exit code is exactly this",
    args: z.object({ code: z.number(), exitCode: runTally.returns.shape.exitCode }),
    from: { exitCode: [runTally, "exitCode"] },
    mutates: false,
    run({}, { code, exitCode }) {
      assert.equal(exitCode, code, `exitCode: expected ${code}, got ${exitCode}`);
    },
  });
  ```

  ```ts
  export default defineStep({
    pattern: "it exits with {code:int}",
    description: "The process exit code is exactly this",
    args: z.object({ code: z.number(), exitCode: runTally.returns.shape.exitCode }),
    from: { exitCode: [runTally, "exitCode"] },
    claims: [{ actual: "exitCode", compare: "equal", expected: "code" }],
  });
  ```

  前の step が値を返した場合は `{ from: "<from のキー>" }` です。

  ```ts
  // Before: run({ request }, { before }) { ...; expect(items.length).toBe(before); }
  args: z.object({ before: countItems.returns.shape.count }),
  from: { before: [countItems, "count"] },
  async observe({ request }) {
    const res = await request.get("/items");
    return { count: ((await res.json()) as unknown[]).length };
  },
  claims: [{ actual: "count", compare: "equal", expected: { from: "before" } }],
  ```

  pattern の固定の語が値を述べる場合は `{ literal }` です。
  pattern が語のとおりに述べないリテラルは import 時に拒否されます。
  そのため、値を step のコードに持っていた文は、値を述べるように書き直します。
  `no` や `empty` のような語が固定する値と比べられるのは `equal` だけです。

  ```gherkin
  # Before: Then the command succeeds
  Then the command exits 0
  ```

  ```ts
  // Before: pattern "the command succeeds", run: expect(exitCode).toBe(0)
  pattern: "the command exits 0",
  claims: [{ actual: "exitCode", compare: "equal", expected: { literal: 0 } }],
  ```

  2 つ目の読み取りの場合は `{ observe: "<path>" }` です。
  `page`、`context`、`pageAs` に届く `observe` は `poll` を述べます(`claim-poll-unstated`)。

  ```ts
  // Before: run({ page }, ...) { ...; expect(firstAt).toBeLessThan(secondAt); }
  async observe({ page }, { first, second }) {
    const titles = await page.locator(".result h2").allTextContents();
    const at = (title: string) => (titles.includes(title) ? titles.indexOf(title) : undefined);
    return { firstAt: at(first), secondAt: at(second) };
  },
  poll: { timeout_ms: 5000 },
  claims: [{ actual: "firstAt", compare: "less-than", expected: { observe: "secondAt" } }],
  ```

- **Then は行のテキストを、スキーマではなく `expected_view` でパースします。**
  claim が読む値を書き換える args スキーマ(`z.coerce`、transform、preprocess、pipe、`trim` などの上書きするチェック、`catch`、デフォルト値か prefault、オブジェクトか配列に付いた refine、args のオブジェクトそのものに付いたこれらのどれか)は import 時に拒否されます。
  JSON の docstring は素の `z.string()` のキーのままにし、claim がそれを JSON として読みます:

  ```ts
  // Before: expected: z.string().transform((text) => JSON.parse(text))
  args: z.object({ expected: z.string(), body: z.unknown() }),
  claims: [{ actual: "body", compare: "equal", expected: "expected", expected_view: "json" }],
  ```

  `Date`、bigint、`Proxy` など、素の JSON でない値に対する claim は実行時に `unjudged` になります。
  値を JSON として返し(ISO 形式の日付の文字列、10 進の文字列、数値)、それに対して claim します。

- **真偽値は、文が使う語か、その背後の計測値になります。**
  `observe` が計算した値に対する真偽値のリテラルは拒否され、文が言うのは `true` ではなく `accepted` です。
  `accepted: boolean` を返していた producer は結果を語として返し、Then は自分の文が述べる語を claim します:

  ```ts
  // Before: returns { accepted: z.boolean() }, and the Then: expect(accepted).toBe(true)
  returns: z.object({ outcome: z.enum(["accepted", "refused"]), reason: z.string().nullable() }),
  // The Then "the sign-in is accepted":
  claims: [{ actual: "outcome", compare: "equal", expected: { literal: "accepted" } }],
  ```

  `{ visible: true }` を返していた `observe` は、見たもの(件数、テキスト、リスト)を返し、claim がそれを比べます。

- **値を読むか記録するだけの Then は When に移すか、読むものに対する claim にします。**
  `examples/migration` では、`Then the created todo id is read back via resultOf` が `Then the created todo is titled "Read a book"` になりました。
  Given や When の位置に結び付いた claim step は `claims-outside-then` で、`*` の行にあるものも同じです。
  キーワードを書いてください。

- **claim step は前の step の値を `resultOf` ではなく `from` で受け取ります。**
  `resultOf` は claim step の中で throw し、プロジェクトの fixture がそこで呼んだときも throw します。
  メッセージはその step を名指しします。
  `resultOf` で読んだ値には `observe:` というラベルが付いていましたが、`from` で読めば、値を返した行を record が名指しします。
  読み取りを `from` に移し、`from` のキーに対して claim を書いてください。

  ```ts
  // Before: observe({ resultOf }) { return { createdTitle: resultOf(createTodo)?.title }; }
  args: z.object({ title: z.string(), createdTitle: createTodo.returns.shape.title }),
  from: { createdTitle: [createTodo, "title"] },
  claims: [{ actual: "createdTitle", compare: "equal", expected: "title" }],
  ```

  実行する step は、これまでどおり `resultOf` を使えます。
  `observe` が受け取る `from` の値を期待値の `{ from }` も読んでいる claim step も、期待値が `{ observe }` のときに実際の値が読む `from` の値を `observe` が受け取る claim step も、`nuka check` が拒否します(`claim-compares-itself`)。
  2 つのうち 1 つを別の step から取ってください。

- **transformer を持つ parameter type は、claim の期待値を埋められません。**
  `nuka check` はそのような pattern を `claim-expected-transformed` として報告し、それが報告されている間は `nuka run` が始まりません。
  `--no-check` の下では、そのようなキーと比べる claim は `unjudged` になります。
  transformer を持たない型、たとえば `{key:string}` でキーをキャプチャし、テキストを JSON や行として読むときは claim に `expected_view` を名指ししてください。

- **`scenario-without-then` が警告する scenario が増えました。**
  `*` の行だけの scenario と、どの Then の行も claim step でない step(compat step)に結び付く scenario も報告されます。
  `nuka check --fail-on scenario-without-then` を走らせるジョブはそれらで失敗するので、それぞれに claim step に結び付く Then の行を書いてください。

- **`nuka scaffold --then` は値を述べない pattern を拒否します。**
  これまでは `observe` が計算した値に対する claim を書いていましたが、いまは `invalid-value` で終了コード 2 を返します。
  `--pattern` で値をキャプチャするか("the count is {count:int}")、語(`none`、`empty`)で述べるか、feature 行に docstring か table を付けてください。
  `nuka scaffold --feature` は、そのような Then の行には stub を書かず、stderr に注記を出します。

- **run.json のフィールドが 3 つ増えました。**
  各 scenario の要素は `claims` を持ち、Then の行のどの claim も判定されなかったものは `judged_by` も持ちます。
  文書は `check` を持ちます。
  scenario の要素や文書を丸ごと比べる読み手はそれらを加えてください。
  キーを名前で読む読み手は何もしなくてかまいません。
  run サマリには「Scenarios with no claim」、`--no-check` のときの `check: skipped` の条件の行、各 claim の行の `measured:` が加わります。

- **`then-mutates` はなくなりました。**
  `nuka check --fail-on then-mutates` はそのコードを `fail-on-unknown-code` で拒否するので、外してください。
  エラーの `then-without-claims` は、フラグなしで check を失敗させます。

- **以前に `nuka scaffold --then` が書いた Then は、実行する step です。**
  それはいまの scaffold が書くものではないので、`--replace` はそれを拒否します。
  上のとおり書き直すか、ファイルを削除して scaffold し直してください。

- **error kind と Allure の category が 3 つずつ増えました。**
  `error.kind` で分岐する読み手は、`claim_broken`、`unobserved`、`claim_unjudged` を加えます。
  以前のリリースの `allurerc.mjs` を持つプロジェクトは、[examples/allure/allurerc.mjs](https://github.com/meganemura/nukadoko/blob/main/examples/allure/allurerc.mjs) から新しい 3 つの rule をコピーします。
  それがないと、Allure 3 はこれらの kind を「Product errors」に入れます。
  Allure 2 の `categories.json` は、`nuka report --format allure` が 10 個すべてを含めて自分で書きます。

- **step ファイルは `defineStep` が返した step を、そのまま export します。**
  `defineStep` は返す step を、その claim、`from`、`parts` とともに凍結するようになり、discovery はコピー(`{ ...step }`、`Object.assign({}, step)`)である default export を拒否します。
  `defineStep` は定義のデータのコピーを検証するので、claim、`from`、`parts`、`poll`、パターンの中にある getter や setter、Proxy、クラスのインスタンス、配列の穴は、呼び出しの時点で拒否されます。
  claim が持たないキーを持つ claim も拒否されます。
  これらは、仕様が名指すキーだけを持つ素のオブジェクトと配列で書きます。
  どれも `step-file-import-failed` として現れます。
  オプションを変えるために step をコピーしていたファイルは、そのオプションを `defineStep` に渡します。
  `parts` に並べる step も、`defineStep` が返したものです。
  呼び出しのあとで別の step の `parts` を変えていたファイルは import の時点で throw するため、`nuka check` は `part-cycle` を報告していた場所で `step-file-import-failed` を報告します。

- **`nuka tend` は削除され、その findings は `nuka check` が報告します。**
  `nuka tend` はいま `removed-command` で拒否します。
  `nuka tend --json` を読んでいたジョブは、プロジェクト全体に対して(feature の対象を指定せずに) `nuka check --json` を実行し、`severity` が `"note"` の findings を残します。
  たとえば `jq '.findings[] | select(.severity == "note")'` です。
  `nuka tend --fail-on X` を実行していたジョブは、`nuka check --fail-on X` を実行します。
  レポートに `X` が含まれると終了コードは 1 になり、`--json` は各ヒットを `fail_on_hits` に並べます。
  feature の対象を指定した `nuka check` と `nuka run` は注記を計算しないので、注記でゲートするジョブはプロジェクト全体の check を実行します。
  `secrets-public-key-unknown` と `secrets-redact-key-unknown` は、どの `nuka check` でも警告として出ます。
  どちらも、`--fail-on` に並べない限り終了コードを変えません。
  tend の要約にあった `scanned:` の行と、フィールドの説明の集計には、代わりがありません。
  `pattern-unbound` は、走査したディレクトリを自分のメッセージの中で名指します。

- **`repeated-scenario-prefix` は `nuka run` が出します。**
  どの `nuka run` も、その run から計測した note として、自分の findings に加えます。
  `run.json` の `findings`、`--json` の文書、stderr の件数の行の後に出ます。
  終了コードは変えません。
  削除された `nuka tend --json` から読んでいたジョブは、代わりに run の `findings` を読み、`code` で絞り込みます。
  この code でゲートしていたジョブは、その code を外します。
  check のレポートにこの code は含まれないので、`nuka check --fail-on` はこれを `fail-on-unknown-code` で拒否します。

- **4 つの note がなくなります。**
  `fixture-replaces-builtin`、`fixture-touches-app`、`parameter-type-support-origin`、`post-navigation-read` は、もう報告されません。
  これらのどれかでゲートしていた、または `--json` をこれらで絞り込んでいたジョブは、そのゲートを外します。
  `nuka check --fail-on` は、この 4 つの code を `fail-on-unknown-code` で拒否します。
  代わりになるものはありません。
  これらが名指していた事実は、見る人のためにいまもディスク上にあります。
  fixture の分割代入、support 側の `defineParameterType`、step record の `actions` です。

- **`nuka run --probe` は削除されました。**
  スクリプトと CI のジョブからこのフラグを外します。
  いまは `removed-flag` で拒否します。
  `findings` から `then-passed-with-changed-capture` や `then-probe-not-measured` を、または run.json から `probes` を読んでいたジョブは、その読み取りを外します。
  この note に代わるものはありません。
  各 Then の step record と step ファイルを読みます。

- **HTTP メソッドによる回数がなくなり、2 つのバージョン番号が上がりました。**
  step record や run.json で `observed.http_reads` や `observed.http_writes` を読んでいたものは、それを外します。
  step record の `http.jsonl` は、各 request をそのメソッドとともに並べます。
  `schema_version` を確かめる読み手は、step record でも、run.json とすべての `--json` の文書でも 4 を受け入れます。
  `nuka report` は以前のリリースが書いた run.json を拒否するので、run はそれを走らせたリリースでレポートします。

- **run サマリに「Declared vs observed」の節はありません。**
  `summary.md` からそれを読んでいたジョブは、その読み取りを外します。

- **`observed` のキーが 3 つ増え、どのキーも常にあります。**
  `{ "processes": null }` のように `observed` を丸ごと比べていた読み手は、代わりに `{ "processes": null, "http": null, "files": null, "unmeasured": [] }` と比べます。
  キーを名前で読む読み手には、することはありません。
  step 自身のコードが `fetch`、`node:http`、`node:https` で送ったリクエストも `http.jsonl` の行になったので、そこで行を数えていたジョブはそれも数えるか、`via` で絞り込みます。

- **`runCommand` は、step が stdin に書いた `input` を残します。**
  新しい `stdin` のファイルが redact されるのは、env ファイルから読み込んだ値か `redact` で名指した値のときだけで、`command` と同じ規則です。
  そのため、step 自身が持つ値を `input` で渡す step は、その値を `redact` で名指します。
  `observed.files` の中身が redact されるのは、env ファイルから読み込んだ値だけです。
  そのため、step がファイルに書く secret は、env ファイルから読み込んだものにします。

- **evidence の名前がさらに 2 つ、harness のものになりました。**
  `ctx.evidence.attach` と `ctx.evidence.path` は、`process-<n>.stdin.txt` と `process-<n>.json`(step が終わったあとに始まった `runCommand` のプロセスのエントリ)を、大文字小文字にかかわらず `ReservedEvidenceNameError` で拒否します。
  どちらかの名前でファイルを添付していた step は、別の名前を選んでください。

- **テスト対象のプログラムは `nukadoko.program.ts` に移り、`runServer` はなくなりました。**
  `runServer` を import する config と step ファイルは読み込めなくなりました。
  config なら、`nuka run` と `nuka check` は次を出力します:

  ```text
  refused	config-invalid	-	Could not import config at nukadoko.config.ts: The requested module 'nukadoko' does not provide an export named 'runServer' (nukadoko.config.ts:1); runServer was removed from nukadoko: nukadoko.program.ts describes the program under test now, and nukadoko starts it once per run with serve: { command, ready } and stops it after
    fix: Remove runServer and the fixture that called it, and write the program's command in nukadoko.program.ts instead; docs/upgrading.md in the nukadoko package, under "The program under test moves to nukadoko.program.ts", shows the move.
  ```

  step ファイルも、`step-file-import-failed` として同じ文と `fix:` の行を受け取ります。
  `baseURL` か `environments` を持つ config は `config-key-removed` で拒否されます:

  ```text
  refused	config-key-removed	-	Invalid config at nukadoko.config.ts: baseURL was removed: the program under test is described in nukadoko.program.ts. Write url there for a program nukadoko does not start (export default defineProgram({ url: "http://localhost:3000" })), or serve for one it starts; the world's URL is the baseURL every page and request resolves against. environments was removed: write each environment in nukadoko.program.ts, with its policy, envFiles, and version; its baseURL is url there, and --env starts that environment's world.
    fix: Remove baseURL and environments from nukadoko.config.ts: write baseURL as url in nukadoko.program.ts (or serve, for a program nukadoko starts), and write each environment under environments in nukadoko.program.ts.
  ```

  config の隣にプログラムのファイルを書き、config からそれらのキーを取り除いてください。
  fixture が `runServer` で起動していたサーバの場合です:

  ```ts
  // nukadoko.config.ts, before
  import { defineConfig, defineFixtures, runServer } from "nukadoko";

  export default defineConfig({
    baseURL: "http://127.0.0.1:3000",
    fixtures: defineFixtures({
      server: async ({ baseURL }, use) => {
        const server = await runServer("node", ["src/server.ts"], { url: baseURL });
        await use(server);
        await server.stop();
      },
      request: async ({ request, server }, use) => {
        void server;
        await use(request);
      },
    }),
  });
  ```

  ```ts
  // nukadoko.config.ts, after
  import { defineConfig } from "nukadoko";

  export default defineConfig({});
  ```

  ```ts
  // nukadoko.program.ts
  import { defineProgram } from "nukadoko";

  export default defineProgram({
    serve: { command: "node src/server.ts", ready: "/" },
    env: { PORT: "{port}" },
  });
  ```

  `server` の fixture、それを起動するためだけの `request` の override、`server` の `StepFixtures` の宣言を取り除きます。
  ポートは nukadoko が選ぶようになったので、プログラムは決まった URL で待ち受けるのではなく、`PORT`(またはコマンドの中の `{port}`)からポートを読みます。
  `port: 3000` と書けば決まったポートのままになり、そこですでに何かが答えていれば nukadoko は拒否します。
  プログラムの準備ができたとみなすのは、ポートが接続を受け付けたときではなく、`ready` が 2xx で答えたときです。
  プログラムは scenario ごとではなく run ごとに 1 回起動します。
  そのため、空のサーバを前提にしていた scenario は Given で状態を作るか、プログラムの状態を `{dir}` に置いて `prepare` で world ごとに作り直します。
  `server.url` を読んでいた step は `baseURL` を読みます。

  `baseURL` と environment があり、サーバは誰かほかの人が起動する場合です:

  ```ts
  // nukadoko.config.ts, before
  export default defineConfig({
    baseURL: "http://localhost:3000",
    envFiles: [".env"],
    environments: {
      staging: { baseURL: "https://staging.acme.example", policy: "read-only", envFiles: [".env.staging"] },
    },
  });
  ```

  ```ts
  // nukadoko.config.ts, after
  export default defineConfig({ envFiles: [".env"] });
  ```

  ```ts
  // nukadoko.program.ts
  import { defineProgram } from "nukadoko";

  export default defineProgram({
    url: "http://localhost:3000",
    environments: {
      staging: { url: "https://staging.acme.example", policy: "read-only", envFiles: [".env.staging"] },
    },
  });
  ```

  `nuka init --server` と `--server-url` は `removed-flag` で拒否します。
  `nuka init` を実行し、プログラムのファイルは手で書いてください。
  run.json を読む側には新しい配列 `worlds` があり、各 step record には新しい `world_name` があります。
  どちらも追加なので、既存の読み方は変わりません。
  `nuka run` の前にアプリを起動していた CI の step は、`serve` が起動するようになれば取り除けます。

- **world へのリクエストは `traceparent` を運び、run に world の URL があるとき `observed` は `program_log` を持ちます。**
  step が world のオリジンへ送るリクエストは、W3C の `traceparent` ヘッダを運ぶようになりました。
  自分で設定したリクエストは、それを保ちます。
  `observed` を丸ごと比べていた読み手は、`program_log`(`{ "trace_id", "lines", "file", "stamped" }`、`url` の world では `null`)を加えます。
  http.jsonl の行を丸ごと比べていた読み手は、nukadoko がヘッダを付けたリクエストの行に `traceparent` を加えます。
  step ごとにプログラムのログの行を得るには、プログラムがリクエストの trace id をログの行に書き、バッファせずに書くようにします。
  Rails と Node の書き方は docs/spec.ja.md の「trace context とプログラムのログ」にあります。
  それまでは、run サマリが world ごとに一度、ログが trace id を持たないこと、またはその行が step が終わったあとに届いたことを言います。

- **`--env` の無い run は、`conditions` を宣言するすべての environment を走らせます。**
  `nukadoko.program.ts` のどの environment も `conditions` を宣言していないあいだは、何も変わりません。
  run は `default` を使います。
  1 つでも宣言すると、`--env` の無い run は、それを宣言する各 environment をファイルが並べる順に走らせ、`default` は走らせません。
  配備先のように宣言しない environment は、`--env` が名指したときに走ります。
  `default` に頼っていた CI のジョブは `--env default` を名指すか、プログラムのファイルが `defaultEnvironments` で選択を名指します。
  `--env` の無い `nuka do` は、これまでどおり `default` を使います。

- **`@with:` か `@without:` で始まる tag は condition を名指します。**
  そうした tag を独自の意味で使っていたスイートは、`nuka check` から `condition-tag-malformed`、`condition-unknown`、`condition-unmet` を受け取り、`nuka run` は始まる前に拒否します。
  tag の名前を変えるか、environment の `conditions` に condition を宣言します(docs/spec.ja.md の「断定」)。

- **run.json の `verdicts` は `table` になりました。**
  `verdicts` を読んでいた読み手は `table.rows` を読みます。
  受け入れ基準ごとに 1 行で、`feature`、`line`、`name`(以前のセルの `scenario`)、environment ごとに 1 つのセルを並べた `cells`、行の `verdict`(`held`、`proven`、`failed`)と `reason` を持ちます。
  セルの `outcome`(`pass`、`fail`、`broke`、`flaky`、`not-run`)が以前の `verdict` を、`runs` が `executions` を置き換えます。
  セルの `conditions` は、その役割のもとになった condition を名指します。
  `passed` は無いので、それが要る読み手は `scenarios` の通ったエントリを数えます。
  condition の tag が無い run は必須(`required`)のセルだけを持ち、その行は、以前のセルが `passed` か `failed` だったとおりに `held` か `failed` になります。
  各 scenario のエントリは `role` を持ち、`counts` は `controls` と `controls_not_run` を持ちます。
  `scenarios`、`passed`、`failed` は必須のセルの実行だけを数え、`not_run` は走らなかった必須のセルを数え、失敗した対照は `do` を持ちません。
  stderr の件数の行も必須のセルだけを数え、対照のある run はその下に `<n> control runs` の行を加えます。

- **run サマリは断定の表で始まります。**
  feature ファイルごとの表と、実行ごとの所要時間はなくなりました。
  表題は受け入れ基準の数と、`held`、`proven`、`failed` の行の数を数え、赤い行はそれぞれ理由を述べる 1 行を得ます。
  `summary.md` を解析していたジョブは、代わりに run.json の `table` を読み、所要時間は各 scenario のエントリの `started_at` と `finished_at` から読みます。

- **Allure の result と messages ストリームは断定を持ちます。**
  Allure の各 result は、parameter `verdict` を新たに持ちます。
  `excluded` なので、`historyId` は変わりません。
  label `role` も 1 つ多く持ち、対照の result の名前は `<scenario> (control)` で、`fullName` は変わりません。
  失敗した対照は、設計どおり失敗した Allure の result です。
  CI は `nuka run` の終了コードでゲートしてください。
  messages ストリームは対照の実行をすべて外すので、JUnit のレポートは必須の実行だけを数えます。
  messages の各 test case は、media type が `application/vnd.nukadoko.verdict+json` の `verdict.json` 添付を 1 つ多く持ちます。
  test case の添付を数える消費者は、1 つ多く数えます。

- **`nuka run --since` はなくなり、`--since` が報告していたことを `nuka run --base <ref>` が断定します。**
  `nuka run --since` は `removed-flag` で拒否されます。
  同じ ref を `--base` に渡します。
  `npx nuka run --since "$(git merge-base HEAD origin/main)"` の代わりに `npx nuka run --base origin/main` です。
  拒否の `do` の行は、`--since` に渡した ref を付けた `nuka run --base` です。
  `--since` は報告するだけで、run を失敗させませんでした。
  `--base` は、新しいか変わった受け入れ基準を基点のコードに対して走らせ、対応づけが変わったときは変わっていない受け入れ基準を基点の step のもとで走らせ、`unproven` か `moved` の行があれば 1 で終わります(docs/spec.ja.md の「断定」)。
  浅いクローンの CI のジョブは、先に基点を取ってきます。
  `base-shallow` の拒否の `do` がそのコマンドです。
  `featuresDir` がプロジェクトのルートであるプロジェクトは、`--base` を使う前に feature と step を専用のディレクトリへ移します。

- **run.json は `since` を持たず、scenario のエントリは `criteria` を持ちません。**
  `criteria.changed_since` を読んでいた読み手は、`table.rows` の行の `change`(`unchanged`、`changed`、`new`、`removed`、そして名前を変えたか移した受け入れ基準の `renamed_from`)を読みます。
  `ambiguous` と `unknown` はなくなりました。
  中身で対にできない同じ名前の scenario は `new` と `removed` になり、parse できない基点の feature ファイルは `base-feature-unparsed` の警告を出して、その受け入れ基準を `new` と数えます。
  `since.removed` を読んでいた読み手は `removed` の行を読み、その `lines` が基点での文を持ちます。
  `since.step_files` に後継はありません。
  対応づけは 1 つの単位として比べ、`table.mapping_changes` が変わったファイルを名指します。
  `--base` のもとでは、`scenarios` は base と old の world の実行も持ち、それぞれ `world` と `row` を持ちます。
  head の実行を数える読み手は、`counts` と同じように `world` を持つエントリを飛ばします。

- **run サマリに「Criteria since」の節はありません。**
  `--base` のもとでは、表の上の 1 行が何が変わったかを数え、対応づけが変わったかどうかを述べます。
  表は `change` の列と、base と old の environment ごとの列を持ち、「Removed criteria」が消えた各受け入れ基準を引用します。

- **`since-*` の拒否のコードはなくなりました。**
  `since-ref-unknown`、`since-outside-git`、`since-git-failed` は `base-ref-unknown`、`base-outside-git`、`base-git-failed` になり、`base-shallow` と `base-features-at-root` が新しく加わりました。
  `since-*` のコードに一致させていたスクリプトは、`base-*` のものに一致させます。

- **step ファイルのリファクタリングは、変わっていないすべての受け入れ基準を old の world で走らせます。**
  old の world は、基点の feature ファイルと基点の step のもとでの head のコードです。
  そのため、対応づけを変えるリファクタリング(step ファイル、features ディレクトリの下の補助、config の `fixtures`、environment の `conditions`)では、変わっていない各行が、今も同じ意味であることを示します。
  基点の step が head のコードに対して走り、通れば行は `held` です。
  features ディレクトリの下の基点の補助は基点の step と一緒に動くので、そこで補助を移したり名前を変えたりしても step は壊れません。
  step を壊すのは、基点の step が import していて head が変えた、features ディレクトリの外のコードです。
  step が手を伸ばすプログラムのモジュールの名前を変えたり移したりしたときです。
  そのとき古い対応づけは読み込めず、変わっていない行はすべて `moved` になり、理由が失敗した import を名指します。
  リファクタリングのあいだその import を動くままにする(古いパスに再 export を残す)か、step が import するものを 1 つの変更で変え、プログラムをその後の変更で変えます。
  どちらもしないリファクタリングでは、その変更のゲートは赤のままです。
  それでも取り込むチームは nukadoko の外でそう決め、次の変更は新しい step を持つ基点と比べます。

- **`url` の関数は `tree` を受け取り、基点には何も返さなくてかまいません。**
  `tree` は `--base` の base の world では `"base"`、それ以外では `"head"` です。
  基点の URL を持たない関数は `undefined`、`null`、`""` を返し、base の world はどのセルも走らせません。
  head に何も返さない関数は、これまでどおり world を `program-start-failed` で失敗させます。
  environment に固定の `url` を書いた base の world も、その URL は head のものなので、どのセルも走らせません。
  既存の `url` の関数は、`--base` で使う前に `tree` で分岐させます。
  base にも head の URL を返す関数では base の world のセルは走らず、その理由は `` the url function returned head's URL for the base tree; branch on `tree` `` です。

- **scenario を 1 つも選ばない run は exit 1 で終わります。**
  まだ scenario の無い対象や、選んだどの scenario の condition も満たさない `--env` で `nuka run` を走らせる CI のジョブは、これまで緑でした。
  今は `nothing-selected` で失敗します。
  scenario を足すか、scenario を持つ対象を名指すか、scenario を満たす environment を名指します。
  `--env` がすべての scenario を外したときは、finding の `do:` 行が、`--env` の有無にかかわらず、それを満たす run です。

- **`check-errors` の拒否の `do:` 行は `:line` を持ちません。**
  対象の各ファイルを 1 回ずつ名指すので、`nuka check` がそのまま走らせます。
  プロジェクトで変えることはありません。
  以前の行を走らせたスクリプトは `line-not-supported` を受け取っていました。

- **step が出力したものは stderr で redact されます。**
  step、hook、fixture が出力した読み込み済みの secret は、record と同じく stderr でも `{{secret.NAME}}` になります。
  その値を nukadoko の stderr から読み戻していたスクリプトは、env ファイルから読みます。

- **world の進行の行は、パスをプロジェクトのルートから名指します。**
  コマンドの `{dir}` や `{root}` は、stderr では `.nukadoko/runs/<run_id>/worlds/<environment>` や `.` になります。
  run.json の `worlds[].commands` は、プログラムが受け取った語のままです。

- **`process.exit` を呼ぶ step は失敗します。**
  `nuka run` と `nuka do` は、step が渡したコードで終わっていました。
  今は step が呼び出しを名指すエラーで失敗し、run は自身のコードで終わります。
  わざと run を終わらせていた step は、代わりにエラーを投げます。

- **`nuka check <targets> --fail-on <note>` は拒否されます。**
  対象を指定した check は注記を計算しないので、そのゲートは発火せず、ジョブは緑でした。
  注記でゲートを掛けるには、拒否の `do:` 行のように対象を名指さない check を使うか、その注記を `--fail-on` から外します。

## 0.20.0 から 0.21.0 へ

- **skill の名前が変わりました。**
  `acceptance` は `nukadoko` に、`verification` は `nukadoko-verification` になりました。
  `gh skill install meganemura/nukadoko --all` で入れたホストは、もう一度インストールし、古い名前のコピーを消してください。
  `<nuka skill path>/acceptance/` と書いたパスは `<nuka skill path>/nukadoko/` になります。

- **migration skill はなくなりました。**
  `gh skill install meganemura/nukadoko --all` で入れたホストには、消すまで古いコピーが残ります。
  それを消し、スイートを移行するエージェントには、代わりに docs/migration.ja.md を案内してください。
  その「進め方の決まり」の節が、skill が言っていたことを運んでいます。

- **evidence の名前が 2 つ、harness のものになりました。**
  `ctx.evidence.attach` と `ctx.evidence.path` は、`process-<n>.stdout.txt` と `process-<n>.stderr.txt` を、大文字小文字にかかわらず `ReservedEvidenceNameError` で拒否します。
  nukadoko が、`runCommand` のプロセスが出力したものをその名前で残すようになったからです。
  そのどちらかの名前でファイルを添付していた step は、別の名前を選んでください。
  レビューする人に読ませるためだけにコマンドの出力を添付していた step は、その添付をやめられます。
  step record がすでにそのファイルを名指しします。

## 0.17.0 から 0.18.0 へ

- **`nuka run --quiet` は削除されました。**
  `removed-flag` で拒否されます。
  短いログが欲しい CI の step は `nuka run --json` を走らせます。
  stderr は空になり、stdout は `run.json` です。

- **Markdown oaths は削除されました。**
  config の `oaths` キーは `config-key-removed` で拒否されます。
  `nuka check` や `nuka run` の `.md` の対象は `markdown-target` で拒否されます。
  各 oath の scenario を、`featuresDir` の下の `.feature` ファイルに Gherkin で書き、`oaths` キーを消してください。

- **session は削除されました。**
  `nuka session list` と `nuka session clear` は `removed-command` で、`nuka do --session` は `removed-flag` で拒否されます。
  各 scenario がすでにそうだったように、`nuka do` の各呼び出しはクリーンに始まります。
  - ログイン状態が必要な step は、それを fixture から得ます。
    Playwright の storageState のファイルを持つプロジェクトは、それを `browserContext.storageState` か `requestContext.storageState` に書きます。
    config はこれらを拒否せず、そのまま Playwright に渡すようになりました。
  - `nuka clean` を走らせるか、`.nukadoko/cache/` を手で消してください。
    それを読むものはなく、`cache/sessions/` は各 session のブラウザの storage state を cookie も含めて持つので、消すまで古いログインがディスクに残ります。
    `nuka clean` は、それと、以前のリリースが書いた `records/` ディレクトリを一覧に出して消し、`--json` の計画では `records` と `export` の横の `legacy` に挙げます。
  - step record の `schema_version` は 3 になり、record は `session` フィールドを持ちません。
    `schema_version === 2` を確かめていた読み手は 3 を確かめます。

- **`nuka experimental explore` とそのモデルの API は削除されました。**
  このコマンド(と、より古い `nuka explore` の綴り)は `removed-command` で拒否されます。
  `experimental_defineModel`、`experimental_defineRelation`、`experimental_modelCommand`、`experimental_relationEntry` は `nukadoko` から export されなくなったので、それらを import するファイルは読み込めません。
  残す価値のある列をそれぞれ scenario として書き、モデルと関係のファイルを消してください。
  `explore-*` の所見の code はなくなりました。

- **`nukadoko/mcp` は削除されました。**
  `@modelcontextprotocol/client` への任意の peer dependency も一緒です。
  `connectMcpServer` や `callMcpTool` を呼んでいた fixture は、SDK 自身の client を使います。
  `@modelcontextprotocol/client` をプロジェクトに加え、fixture の setup で `StdioClientTransport`(`@modelcontextprotocol/client/stdio` から)を使う `Client` を作り、teardown で閉じてください。

- **各 run は 1 つのディレクトリ `.nukadoko/runs/<run_id>/` になり、`records/` は書かれなくなりました。**
  state directory を読むスクリプト、CI の step、ツールは、次のパスを変えます。
  - `.nukadoko/records/runs/<run_id>/run.json`、`summary.md`、`exports` は、`.nukadoko/runs/<run_id>/run.json`、`summary.md`、`exports` です。
  - `.nukadoko/records/steps/<id>/` は、`nuka run` が走らせた step なら `.nukadoko/runs/<run_id>/steps/<id>/`、`nuka do` の呼び出しなら `.nukadoko/do/<id>/` です。
  - `.nukadoko/records/scenarios/<id>/` は `.nukadoko/runs/<run_id>/scenarios/<id>/` です。
  - `run.json` の中のパス(step の `record`、`used` のエントリの `record`、scenario の `evidence.dir`)はすべて run ディレクトリからの相対パスです。
    `.nukadoko/records/steps/<id>` ではなく `steps/<id>` と書かれます。
    `run.json` を持つディレクトリと結合してください。
    run サマリの `record` のセルも同じパスです。
    step record 自身の `evidence.dir` は、これまでどおりプロジェクトのルートからの相対パスです。
  - `.nukadoko/records/` をアップロードしていた CI の step は、`.nukadoko/runs/` をアップロードします。
    docs/ci.ja.md に、コミットに固定した `actions/upload-artifact` の step があります。
    `.nukadoko` は隠しディレクトリなので、その step は `include-hidden-files: true` を設定します。
  - retention の行の日数の部分に一致させていたスクリプトは、`unfinished runs and nuka do records older than` に一致させます。
  以前のリリースが残した `.nukadoko/records/` は読まれず、retention も `nuka clean` もそれを消しません。
  手で消してください(`rm -rf .nukadoko/records`)。
  そのディレクトリの id を `nuka do --use` に渡すと、見つからないとして拒否されます。
  値を作る step をもう一度走らせてください。
  export の出力は動きません。

- **`run.json` が run のすべてを持ち、scenario record のファイルはなくなりました。**
  `run.json` や `nuka run --json` を読むスクリプトは、次の読み方を変えます。
  - `schema_version` は envelope の 2 で、文書は `command: "run"`、`verdict`、`findings` で始まります。
    `findings` は、失敗した各 scenario に加えて、run が出したすべての警告を持つようになりました。
  - scenario の `rerun` は `do` になり、失敗した scenario にだけあります。
    その `record`(scenario record のファイルのパス)はなくなりました。
    代わりに `steps` を読みます。
    各 step は `line`、`text`、`step`、`status`、`step_record_id`、`record`(step record のディレクトリ)を持ち、失敗なら `error.kind`、`error.message`、`used` も持ちます。
  - 最上位の `summary` のパスはなくなりました。
    サマリは、`run.json` と同じディレクトリの `summary.md` です。
  - `commit`(`sha`、`dirty`)、`target_version`、`selection` が加わりました。
    scenario record の `git.clean` を調べていたスクリプトは、`!commit.dirty` を調べます。
  - `.nukadoko/records/scenarios/<id>/record.json` を読んでいたスクリプトは、`run.json` の中のその scenario のエントリを読みます。
    このファイルはもう書かれません。
    スクリーンショット、hook の trace、添付のどれも書かなかった scenario は、scenario の evidence のディレクトリを残しません(それがいまどこに置かれるかは、上の run ディレクトリの項目を参照)。
  - stderr の「Partial run」の段落に一致させていたスクリプトは、`run.json` の `selection`(`partial` か `full`)か、run サマリの `- selection:` の行を読みます。
  - `--records` の行は、いまは scenario の `run.json` のエントリです。
    `run_id`、`environment`、`git`、`nukadoko`、`schema_version` は持たないので、それらは `run.json` から読みます。
  run サマリには `- selection:` の行と「Findings」の節が加わります。
  サマリを投稿するだけの CI の step は、何も変える必要がありません。

- **すべてのコマンドの `--json` は 1 つのenvelopeになり、すべての finding は 1 つの文法になりました。**
  `--json` を読むスクリプトは `{ schema_version: 2, nukadoko, command, verdict, findings, ... }` を読みます。
  - `errors`、`warnings`、`notes` はなくなりました。
    `findings` を `severity`(`error`、`warning`、`note`、`refused`、`failed`)で絞り込みます。
  - 拒否はもう `{ error, do }` ではありません。
    severity が `refused` で code を持つ finding になり、終了コードは引き続き 2 です。
    メッセージではなく `code` で分岐します。
  - `nuka steps --json` は `findings` の隣に `steps` を持ち続けます。
    その `import_failures` は `step-file-import-failed` または `playwright-missing` の finding になりました。
    `nuka describe` は契約のフィールドを `findings` の隣に持ち続けます。
    `nuka tend --json` は `summary` と `fail_on_hits` を持ち続けます。
    `nuka run --json` は `run.json` のフィールドを持ち続けます。
    `nuka check --codes --json` と `nuka tend --codes --json` は `codes` を持ち続け、各エントリは finding です。
    意味は `description` ではなく `message` に、全般的な編集は `do` ではなく `fix` に入ります。
    envelopeの `verdict` を読みます。
  - `verdict` は終了コード 0、1、2 に対して `passed`、`failed`、`refused` です。
- **finding のテキストは `<severity>\t<code>\t<where>\t<message>` で、その後に `  fix:` と `  do:` の行が続きます。**
  `nuka check` のテキストを解析するスクリプトは、最初の列で severity を読みます。
  `  do:` はいまはシェルがそのまま実行できるコマンドだけです。
  「Escape the bare ( ) ...」のような言葉によるヒントは `  fix:` の行にあります。
  すべての `do:` の行を文章として読んでいたスクリプトは、文章として読むのをやめます。
  それを実行するスクリプトは、そのまま実行できます。
- **失敗した scenario は `scenario-failed` の finding です。**
  stderr の `failed` と `rerun` の行はなくなりました。
  `rerun` を grep していたスクリプトは、各 `failed\tscenario-failed\t` の行の下にある `  do: nuka run <feature>:<line>` の行か、`run.json` の失敗した各 scenario の `do` を読みます。
- **警告は code を持つ finding です。**
  config が無いことを伝える行は stderr の `warning\tconfig-missing\t-\t...` になり、`--json` では `findings` に入って stderr は空です。
  fixture の teardown の失敗(`fixture-teardown-failed`)、emitter の失敗(`emitter-failed`)、応答しなかった version probe(`version-probe-failed`)、そして `nuka check --codes` が挙げるそのほかの run の警告も同じです。
  stderr の `Warning:` に一致させていたスクリプトは、`warning` の列と code に一致させます。
- **`undefined-step` のメッセージは scaffold コマンドを名指ししなくなりました。**
  コマンドは `  do:` の行にあります。
  未定義の step を持つ行は、同じテキストの 2 行目も含め、それぞれ自身の finding を持つようになりました。
  そのため `undefined-step` の finding の数は行の数です。

- **`nuka run` は、`--records` のときだけ scenario record を stdout に出力します。**
  パイプ、ファイル、CI のログ、エージェントのシェルには、既定では 1 行 1 件の JSON の record が出力されなくなり、stdout は空のままです。
  その列を解析していたスクリプトは、次の 3 つから 1 つを選びます。
  読んでいる `nuka run` に `--records` を足します(各行はいまは scenario の `run.json` のエントリで、下の `run.json` の項目で述べます)。
  または `--json` に切り替えます。
  または、run がフラグにかかわらず書く `.nukadoko/runs/<run_id>/run.json` を読みます。
  ログを表示するだけの CI の step は、何も変える必要がありません。
  run サマリ、stderr の行、`nuka do` の stdout は変わりません。
- **`evidence.attach` と `evidence.path` は `trace.<name>.zip` と `final.<name>.png` を拒否します。**
  `pageAs(name)` の context は、step 自身の `trace.zip` と `final.png` の隣にそれらのファイルを書きます。
  そのため、有効なすべての context 名について、大文字小文字を問わず、これらの名前は `ReservedEvidenceNameError` で予約されます。
  そのような名前でファイルを添付していた step は、たとえば `trace-aki.zip` や `aki-final.png` に名前を変えます。
- **`nuka tend` はすべての code を報告し、`--all` は削除されました。**
  素の `nuka tend` は、テキストでも `--json` でも `schema-field-undescribed` を報告するようになりました。
  `nuka tend --all` はそう告げて終了コード 2 で終わるので、このフラグを外します。
  素の `--json` を読んで一部の code にだけ対応するジョブは、`findings` を `code` で絞り込むか、対応する code ごとに `--fail-on` を渡します。
  `nuka tend --codes` は各 code を finding として出力し(次の項目を参照)、エントリに `reportedByDefault` はありません。
- **step record の `observed` のチャネルは、step が一度も届かなかったとき `null` です。**
  `ctx.request()`、`ctx.page()`、`pageAs()` のどれも呼ばず、request も記録されなかった step では、`http_reads` と `http_writes` はどちらも `null` です。
  一度も `runCommand` を呼ばなかった step では、`observed.processes` は欠けるのではなく `null` になります。
  step record の `schema_version` は 2 です。
  件数を合計するスクリプトは、`null` を `0` ではなく「計測していない」として扱います。
  `processes` キーが無いことを調べていたスクリプトは、`null` を調べます。
  0 という件数に意味を持たせたい step は、`fetch` ではなく `request` fixture を通じてサーバを呼びます。
- **`--json` は 1 つの文書を出し、その周りには何も出しません。**
  `nuka run --json` の stderr から `run` のパス、件数の行、`rerun` の行を拾っていたスクリプトは、それらを文書から読みます: `counts` と、失敗した各 scenario の `do` です。
  `--json` の拒否を行で区切っていたスクリプトは、stdout を 1 つの JSON 値として解析します。
  拒否はいまは整形されて出力されます。
  `nuka steps` のテキストを 80 以外の端末幅で比べていたテストは、80 で比べます。
- **`run.json` は run のすべての environment を名指し、scenario と environment の組ごとに 1 つの断定を持ちます。**
  run を読む側で変わるのは次のとおりです。
  - `run.json` の `environment` を読んでいたスクリプトは `environments[0].name` を読み、`target_version` の代わりに `environments[0].target_version` を読みます。
    `--env` の無い run は `default` の 1 件を持ちます。
  - scenario を `scenarios` のエントリで判定していたスクリプトは `verdicts` を読みます。
    scenario と environment の組ごとに 1 つのセルがあり、`verdict`、`executions`、`passed` を持ちます。
    `scenarios` の各エントリも自分の `environment` を名指します。
  - run サマリの表を解析していたスクリプトは、`status` を読んでいたところで environment の名前の列(`--env` が無ければ `default`)を読みます。
    `--repeat` で実行ごとに 1 行だったところは、scenario ごとに 1 行になります。
  - environment ごとに `nuka run --env` を走らせていた CI のジョブは、`nuka run --env a --env b` を 1 つの step にでき、サマリも 1 つになります。
  - 古い history id を鍵にした Allure の履歴は、一度だけ最初からになります。
    environment が result の identity の一部になったからです。

- **`nuka run` は Allure の result も messages ストリームも書かず、run の後に `nuka report` がそれを描き出します。**
  `allure` と `messages` の config キーは `config-key-removed` で、`nuka run --summary` は `removed-flag` で拒否されます。
  - config から `allure` と `messages` のキーを消します。
  - `nuka run` の後に `.nukadoko/export/allure-results/` を読んでいたスクリプトや CI の step は、run の後にまず `nuka report --format allure` を実行します。
    `allure.resultsDir` で出力先を移していたなら、そのディレクトリを `--out` に渡します。
  - `messages.ndjson` を読んでいたところでは、`nuka report --format messages --out <path>` を実行します。
    `messages.<run_id>.ndjson` を読んでいたところでは、その run を `nuka report .nukadoko/runs/<run_id> --format messages --out <path>` で描き出します。
  - `nuka run --summary <path>` で pull request のコメントを書いていたところでは、run の後の step で `nuka report --format markdown --out <path>` を実行します。
    赤い run も投稿されるよう、その step には `if: always()` を付けます。
  - 以前のリリースの run には `sources.json` がないため、その run の Allure や messages への描き出しは `run-sources-missing` で拒否されます。
    描き出すには、scenario をもう一度実行します。
  - Allure の履歴はそのまま続きます。
    result の identity は変わっていません。
    `host` と `thread` の label はなくなり、`allure watch` が run を映すのは、run の実行中ではなく描き出したときです。
  - 複数の environment にわたる run の messages ストリームから作った JUnit や HTML のレポートは、各 scenario を environment ごとに 1 回ずつ、`<scenario> (<environment>)` という名前で示します。
  - `emitter-failed` や `export-path-outside-project` のコードに合わせていたスクリプトは、前者を `report-incomplete` に合わせます。
    後者に後継はありません。
    `nuka clean` が config からパスを読まなくなったからです。
    `emitter-failed` は警告でしたが、`report-incomplete` では `nuka report` が 1 で終了します。
    ファイルを失った run ディレクトリを描き出す CI の step は失敗するので、run ディレクトリ全体をアップロードします。
  - `nuka clean` が `.nukadoko/export/` の下で消すのは、run の exports manifest が名指すファイルと `allure-results/` の中身だけです。
    `allure generate` のレポートのように nukadoko が書いていないファイルはそこに残ります。
    以前の clean で消えていたなら、自分で消します。

- **読めない env ファイルは、`nuka run --no-check` でも `env-file-unreadable` と exit 2 で拒否されます。**
  これまではどのコマンドでも `unexpected-error` で、`--no-check` では exit 1 の `error` finding でした。
  読めない env ファイルを `unexpected-error` に合わせていたスクリプトや、そこでの exit 1 を失敗した run と読んでいたスクリプトは、`env-file-unreadable` と exit 2 に合わせます。
  何も実行されていないからです。

## 0.16.1 から 0.17.0 へ

- **`nuka run` は、stdout が端末のとき、stdout に scenario record を出力しません。**
  パイプ、ファイル、CI のログ、エージェントがパイプ越しに動かすシェルには、これまでどおり 1 行 1 件の JSON の record が出力されます。
  疑似端末の下で `nuka run` を動かし、その stdout を解析するツールは `--records` を渡します。
  `--records` を渡すと、端末にも record が出力されます。
  ディスク上の record、stderr の行、`nuka do` の stdout は変わりません。
- **Node は 22 系なら 22.18.0 以降、それ以外なら 23.6.0 以降が必要です。**
  `engines.node` は `^22.18.0 || >=23.6.0` です。
  これらは、Node がフラグなしで TypeScript の型を除去する最初のリリースです。
  nukadoko は config、step ファイル、それらが import するすべてを、Node 自身を通して読み込むようになりました。
  tsx にはもう依存しません。
  Node 20 や、それより前の 22 に固定した CI ジョブは、対応するバージョンへ移ってください。
  `docs/ci.ja.md` は 24 を使っています。
  Node 23.6 から 23.x は、最初に `.ts` ファイルを読み込むときに `ExperimentalWarning` を出します。
  22.18 と 24 以降は出しません。
- **型を除去しても形が崩れない TypeScript だけが読み込めます。**
  `enum`、値を持つ `namespace`、コンストラクタのパラメータプロパティは実行時の振る舞いを持つため、Node はそのファイルを拒否します。
  step ファイルが import するプロジェクトのファイルにも同じことが当てはまります。
  `nuka check` は `step-file-import-failed` を、ファイル、行、代わりに書くものと一緒に報告します。
  enum は `as const` を付けたオブジェクトに、パラメータプロパティはコンストラクタで代入するフィールドになります。
  `tsconfig.json` に `"erasableSyntaxOnly": true`(TypeScript 5.8 以降)を設定すると、nuka より先に `tsc` がそれぞれを報告します。
  Node 23.x では、Node の報告はファイルを示しません。
  step ファイル自身がその構文を含むときは、finding は引き続き行を示します。
  import したモジュールが含むときは、finding は行を持たず、そのことを伝えます。
- **`type` を付けずに import した型は読み込みに失敗します。**
  Node は `import { Options } from "./options.ts"` が型だけを指していると判断できません。
  そのため import は "does not provide an export named 'Options'" で失敗します。
  `import type { Options }` か `import { type Options }` と書いてください。
  `"verbatimModuleSyntax": true` を設定すると、`tsc` がこの書き方を求めます。
  `nukadoko/compat` の `IWorldOptions` のように nukadoko が export する型については、`nuka check` の finding が `import type` と書くよう伝えます。
- **`nuka scaffold` は、`tsc` が `.ts` の名前を受け入れるとき、`--from` の producer をその名前で import します。**
  `--from run-greet.<key>` で scaffold した step は、`tsconfig.json` かそれが extends するファイルが `rewriteRelativeImportExtensions` か `allowImportingTsExtensions` を true にしているとき、`./run-greet.ts` を import します。
  プロジェクトに `tsconfig.json` がないときも同じです。
  それ以外のときは `./run-greet.js` を import し、そのオプションを名指す `note:` 行を stderr に書きます。
  すでに `.js` の名前で import している step ファイルは、nuka のもとでは読み込まれ続けます。
  `.js` ファイルがなければ、nuka は `.ts` ファイルにフォールバックするからです。
  そのため、名前の書き換えは任意です。
  そのファイルを素の `node` で実行した場合は、フォールバックしません。
  `tsc` が `.ts` の名前を受け入れるには、`tsconfig.json` に `"rewriteRelativeImportExtensions": true`(TypeScript 5.7 以降)か `"allowImportingTsExtensions": true` が必要です。
  後者を `tsc` が受け入れるのは `noEmit` のときだけです。
  `nuka init` は、自身の `compilerOptions` を持ち、どちらのオプションも名指していない `tsconfig.json` に、前者を追加するようになりました。
  ただし、それが `extends` するファイルがどちらかを名指していれば追加しません。
  オプションが `extends` を通してだけ届く `tsconfig.json` には、代わりに stderr に 1 行を書きます。
  このリリースより前に init したプロジェクトは、手で追加してください。
- **`tsconfig.json` の `paths` と `baseUrl` は、実行時にはもう解決されません。**
  tsx はそれを読みましたが、Node は読みません。
  `paths` を通して `@app/server` を import する step ファイルは、import に失敗します。
  相対パスか、`package.json` の `imports` にある `#app/*` のエントリを使ってください。
  Node と `tsc` の両方がそれを読みます。
- **`"type"` のない `package.json` のもとでも、ES module として書いた `.ts` ファイルが読み込まれるようになりました。**
  Node はそのファイルを解析し直し、そうしたファイルごとに `MODULE_TYPELESS_PACKAGE_JSON` の警告を出します。
  `nuka init` はそこでは引き続き `nukadoko.config.mts` を書き、`.mts` の step ファイルは警告なしで読み込まれます。
  `.ts` の名前のまま警告をなくすには、`package.json` に `"type": "module"` を追加してください。
  `nuka tend` はこれを `package-type-missing` として報告します。
  `"type": "commonjs"` のもとでは、`.ts` ファイルは引き続き import に失敗し、エラーは `.mts` に名前を変えるよう伝えます。
- **`undefined-step` のメッセージは `nuka scaffold --feature <file>` を名指します。**
  以前は「run `nuka scaffold <name>` to add one」で終わっていました。
  今は、その行がある feature ファイルを名指すので、そのコマンドはそのファイルの未定義の行すべてに stub を書きます。
  code と、その `file` と `line` は変わりません。
  `nuka run --no-check` のもとでは、scenario record にある未定義の step の `error.message` も同じように変わります。
  古い文に一致させているスクリプトは、代わりに code に一致させるか、scenario record にある step の `status: "undefined"` に一致させます。
- **成功した step record は `"status": "ok"` ではなく `"status": "passed"` と書きます。**
  step record、scenario record の `steps[]` と `hooks[]`、`nuka experimental explore --json` の `steps[]` で、成功を表す語が同じになりました。
  `.status == "ok"` を調べるスクリプトや jq のフィルタは、`"passed"` を調べるようにします。
  nukadoko 0.16.1 以前が書いた record は、ディスク上では `"ok"` のままです。
  `nuka do --use` と各 emitter はそれを `"passed"` として読むので、retention が削除するまで残しておけます。
  export されている TypeScript の型 `StepRecordOk` は `StepRecordPassed` になりました。
- **`nuka run` が stderr に書く step の行は、`ok`、`FAIL`、`skip` ではなく `passed`、`failed`、`skipped` と書きます。**
  同じ結果に step record と同じ語を使うようになりました。
  CI のログから `  FAIL  ` を探すスクリプトは、`  failed  ` を探すようにします。
- **`nuka tend --json` の summary のキーは snake_case になりました。**
  `typedSteps`、`compatSteps`、`compatStepNames`、`scannedFeatureDirs`、`readOnlySteps` は、`typed_steps`、`compat_steps`、`compat_step_names`、`scanned_feature_dirs`、`read_only_steps` になります。
  `describe` の名前は変わりません。
- **`nuka describe` は `from` を `nuka steps --json` と同じ形で示します。**
  producer が 1 つのキーは、文字列 `"create-project.id"` ではなく `{ "step": "create-project", "key": "id" }` になります。
  producer が複数のキーは、`"either of A or B"` ではなく、そのオブジェクトの配列になります。
- **`nuka run --session` はなくなりました。**
  終了コード 2 で終わり、何も書きません。
  ログイン状態が必要な scenario は、その feature が名指す fixture か Given step から得ます。
  そのため各 scenario は、前に何が動いたかにも `--concurrency` にも関係なく、クリーンに始まります。
  `scope: "process"` の fixture でログインすれば、ログインは scenario ごとではなくプロセスごとに 1 回です。
  `nuka do --session <name>` は変わりません。
- **`nuka init` が受け付けるのは `--allure` だけです。**
  `--base-url`、`--features-dir`、`--env` は、代わりになるものを名指して終了コード 2 で終わり、何も書きません。
  `baseURL` は `init` のあとで、生成された config に設定してください。
  `features/` 以外の features ディレクトリを使うときは、config に `featuresDir` を設定し、`features/steps/` をそこへ移してください。
  `init` は `.gitignore` に `.env`、`.env.*`、`!.env.example` を必ず追加するようになりました。
  プロジェクトが意図して `.env` をコミットしているなら、その行を消してください。
  `--env` はこのリリースの前に一時期 `--env-files` という名前でした。
  その名前も同じように拒否されます。
- **`nuka clean` が受け付けるのは `--dry-run` と `--json` だけです。**
  `--records`、`--cache`、`--export` は終了コード 2 で終わり、何も消しません。
  `nuka clean` は record、cache、export を必ずまとめて消します。
  どれかを残したいときは、先に `.nukadoko/` の外へコピーするか、毎回の `nuka run` の終わりに retention が古い run を消すのに任せてください。
- **`nuka check --codes --json` と `nuka session list --json` は、素の配列ではなくオブジェクトを出力します。**
  JSON の文書はすべて `schema_version` で始まるようになり、配列にはそれを置く場所がありません。
  一覧は 1 つのキーの下に移りました。
  `{ "schema_version": 1, "codes": [...] }` と `{ "schema_version": 1, "sessions": [...] }` です。
  jq のフィルタ `.[]` は `.codes[]` または `.sessions[]` になります。
  ほかの文書は先頭に `schema_version` キーが加わっただけで、step record と scenario record にはさらに `nukadoko` が加わりました。
- **`records/runs/<run_id>/complete.json` は `run.json` になりました。**
  run の完了の印が、run の結果全体になりました。
  `complete.json` が `verdict`、`finished_at`、`failed_scenarios` として持っていたものは、`verdict`、`finished_at`、`counts.failed` にあります。
  その横に、run の id、record と再実行のコマンドを伴うすべての scenario、サマリのパスが並びます。
  `complete.json` を読んでいたスクリプトは `run.json` を読むか、`nuka run --json` を実行して stdout を読みます。
  0.16.1 以前が書いた run には `complete.json` しかありません。
  retention はもうそれを run が終わった証拠として読まないので、そうした run は `retention.adHocDays` より古くなるまで残ります。
  `nuka clean` を使えば今すぐ消せます。
  cache と export も一緒に消えるので、残したいものは先にコピーしてください。
- **`nuka scaffold` は、config を持つディレクトリより下では書き込みを拒否します。**
  `nukadoko.config.ts` も `nukadoko.config.mts` も無く、`.git` を持つ最も近いディレクトリまでの親ディレクトリに config がある場所では、`Refusing to scaffold:` とその config への相対パスを出して終了コード 2 で終わります。
  以前は、その config が読まない step ファイルを書いていました。
  `nuka scaffold` は config があるディレクトリ、workspace ならそのパッケージで実行します。
  サブディレクトリで scaffold していたスクリプトは、`cd` の先を変えます。
  ほかのコマンドは終了コードと stdout を変えず、config が無いことを示す 1 行を stderr に足すだけです。
- **1.61.1 より新しい Playwright 1.x を使うプロジェクトは、その版のままで構いません。**
  `playwright` の peer の範囲は、正確な `1.61.1` ではなく `^1.61.1` になりました。
  npm は、それより新しい 1.x の横にも `ERESOLVE` なしで nukadoko をインストールします。
  nukadoko のためだけに自分の `playwright` を 1.61.1 に固定していたプロジェクトは、新しい版へ進めて構いません。
  nukadoko がテストしている版は 1.61.1 のままで、`playwright-missing` のインストール行もその版を示します。
- **`defineStep` は `rationale` を受け取らなくなりました。**
  step ファイルから `rationale:` の行を消してください。
  消すまでは、`nuka check` がそれぞれについて step ファイルを挙げて `step-option-ignored` を 1 回ずつ警告します。
  `tsconfig.json` が step ファイルを含むなら、`tsc` もそれぞれを余分なプロパティとして報告します。
  `nuka` は実行時にその値を無視するので、run は変わりません。
  残す価値のある理由は、`defineStep` の上のコメントへ移せます。
  `nuka describe` は `rationale` のキーを出力せず、`nuka tend --json` には `summary.rationale` がありません。
- **`returns` のない step は、`run` がキーを持つオブジェクトを返すと失敗します。**
  これまでは値が捨てられ、step が通る一方で step record には `{}` が残りました。
  今は step が `result_invalid` で失敗し、メッセージがそのキーを挙げます。
  値を record に残す価値があるなら、そのキーを持つ `returns` を宣言してください。
  そうでなければ、返すのをやめてください。
  `tsconfig.json` が step ファイルを含むなら `tsc` がすでにそうした return を拒否していたので、step ファイルを型チェックするプロジェクトには変化がありません。
- **`nuka tend` は `step-rationale-missing`、`additional-feature-dir-missing`、`import-failures-unseen` を報告しなくなりました。**
  1 つ目は `rationale` とともになくなりました。
  残りの 2 つは、`nuka check` がすでに `additional-feature-dir-missing`(エラー)と `step-file-import-failed` として報告することを述べていました。
  代わりに `nuka check` の exit code でゲートを掛けてください。
  この 3 つのどれかを渡した `nuka tend --fail-on` は exit 2 で終わり、代わりに何をするかを伝えます。
  そのため、どれかを名指す CI ジョブは、書き換えるまで失敗します。
  `declared:` の行は `declared: describe <n>/<total>` になります。
  `rationale` の件数を読むスクリプトは、代わりに `describe` の件数を読みます。
- **`nuka harvest` は削除されました。**
  終了コード 2 で終わり、この注記を名指しします。
  実行した `nuka do` の呼び出しから scenario を書いてください。
  実行した順に step ごとに 1 行を、その pattern に合う文で書き、`Given`、`When`、`Then` は、その行が読み手に何を伝えるかで選びます。
  先行する step が生んだ値は行に書きません。
  step の `from` がそれを供給するからです。
  そのあと `nuka check` を実行すると、すべての行が語彙に照らして読み戻されます。
  acceptance skill の「Where to start」で探索から始める道筋も同じことを述べています。
- **live session は削除されました: `nuka session start`、`nuka session stop`、`--idle-timeout` です。**
  `nuka session start` と `nuka session stop` は終了コード 2 で終わり、この注記を名指しします。
  `nuka do <step> --session <name>` は、保存された storageState ファイルとして、今までどおり呼び出しをまたいでログイン状態を持ち運びます。
  `nuka session list` と `nuka session clear` も、今までどおりそのファイルを一覧し、削除します。
  live session の目的だった、状態を繰り返せないブラウザのアプリの探索は、agent のホストの Playwright MCP サーバを通すようになりました。
  Claude Code のホストは `claude mcp add playwright npx @playwright/mcp@latest` で追加します。
  そのサーバがつながっているかどうかの見分け方と、見つけたことを scenario にする方法は、acceptance skill が述べています。
  サーバの `--isolated --storage-state=<file>` オプションを使うと、`nuka do --session` が保存した session から始められます。
  live session がなくなったので、step record は `session_execution` を持たなくなりました。
  `nuka do --session` は、session が live でないと告げる行を出さなくなりました。
  `nuka run` は live session を報告せず、そのために retention を飛ばすこともなくなりました。
  `nuka clean` は、session の lock file が保持されている間も拒否しなくなりました。
  session を起動し、`nuka do --session` で動かし、停止していたスクリプトは、`nuka do --session` だけで同じログイン状態を得ます。
  ログイン以外の状態は呼び出しをまたいで持ち越されません。
- **`recordStep`、`RecordStepOptions`、`StepExecution`、`UnsupportedExternalFixtureError` は export されなくなりました。**
  `recordStep` を import している Playwright Test の spec はコンパイルに失敗します。
  step の `run` が呼んでいる共有関数を spec から直接呼び、`nukadoko` の import を削除してください。
  そうすると spec は再び Playwright だけに依存します(docs/migration-playwright-test.ja.md の「共有するのは runner ではなく実装」)。
  `recordStep` が書いた record は、retention が削除するまで `kind: "external"` のままディスクに残ります。
- **`nuka check` と `nuka tend` のテキスト出力は、各所見の下に `do:` の行を出し、step の所見ではその step ファイルを示します。**
  その行は 2 つの空白で始まります(`  do: nuka scaffold --feature features/greet.feature`)。
  1 つの step についての所見では、3 列目は step の名前ではなく step ファイルになりました。
  メッセージは引き続き step を名指します。
  `--codes` のテキストには 4 列目として、そのコードの一般的な `do` が加わりました。
  テキスト出力を読むスクリプトは、2 つの空白で始まる行を読み飛ばすか、`--json` を読みます。
  `--json` では `file` と `do` がフィールドで、それ以外は変わりません。
- **`nuka explore` は `nuka experimental explore` になりました。**
  フラグも出力も同じです。
  `nuka explore` は終了コード 2 で終わり、新しい綴りを示します。
  そのため、`nuka explore features/explore/add-model.ts` を実行していた script は `nuka experimental explore features/explore/add-model.ts` に変えてください。
  model や relation のファイルは、名前の変わった関数を import します。
  `defineModel` は `experimental_defineModel`、`modelCommand` は `experimental_modelCommand`、`defineRelation` は `experimental_defineRelation`、`relationEntry` は `experimental_relationEntry` になりました。
  型の名前は変わりません。
  `experimental` の下にあるため、このコマンドと関数は、後のリリースで非推奨の告知なしに形が変わったりなくなったりすることがあります。
- **`nuka experimental webmcp-tools`、`experimental_callWebmcpTool`、`nuka experimental mcp-tools` は削除されました。**
  どれも実験的でした。
  MCP サーバのツールを一覧にするには、エージェント自身の MCP ホストか、MCP Inspector のような MCP クライアントを使ってください。
  `experimental_callWebmcpTool` を呼んでいた step は、`page.evaluate` を通じてページのツールを自分で呼びます。
  `nukadoko/mcp` の `connectMcpServer` と `callMcpTool` は変わりません。
- **`--json` を付けたコマンドが拒否すると、stdout に `{ "schema_version", "error", "do" }` を書きます。**
  これまでは stderr に文を書き、stdout には何も書きませんでした。
  終了コードが 0 のときだけ stdout を読むスクリプトには影響しません。
  理由を stderr から読んでいたものは、JSON の行の `error` を読みます。
  `do` は次に実行するコマンドを示します。
  `nuka describe` は `--json` の有無にかかわらず、この形で答えます。
  `--json` なしの拒否は stderr のメッセージを保ち、最後に `do: <command>` の行を足します。
- **拒否したコマンドは 1 ではなく 2 で終了します。**
  これまで終了コード 1 は「suite が red」と「何も実行されなかった」の両方を意味していました。
  今は前者だけを意味します。
  `nuka check` のエラー、失敗した scenario、失敗した `nuka do` の step、`nuka tend --fail-on` に当たった code です。
  拒否(知らないフラグ、不正な config、存在しない対象、知らない step、入っていない peer dependency、`nuka check` が報告するエラーで止まった `nuka run`)は 2 で終了します。
  `!= 0` を調べるスクリプトや CI の step はそのまま動きます。
  「red」の意味で `== 1` を調べるものは、拒否を見逃すようになります。
  「green でない」なら `!= 0` を、「呼び出し方を直す」なら `== 2` を調べてください。
  表は docs/spec.ja.md の「ストリームと終了コード」にあります。

## 0.15.0 から 0.16.1 へ

- **`nuka tend` は、求められない限り `step-rationale-missing` と `schema-field-undescribed` を外します。**
  `rationale` や `.describe()` の欠けは、プロジェクトが抱えたままでいられるものです。
  毎回の run で両方を報告すると、本当の腐敗についての所見が埋もれていました。
  `nuka tend --all` はこの 2 つを、テキストでも `--json` でも再び報告します。
  `nuka tend --fail-on step-rationale-missing`(または `schema-field-undescribed`)を実行するジョブは、そのまま動き続けます。
  `--fail-on` で code を名指すと、その code は報告されるからです。
  どちらかの code を素の `nuka tend --json` から読むジョブやスクリプトは、`--all` を足します。
  注記を黙らせるためだけに書いたプレースホルダーの `rationale: ""` は消してかまいません。
- **`nuka tend` は既定で `step-description-todo` を報告します。**
  description がまだ `TODO: describe` で始まる型付き step、つまり `--description` なしの `nuka scaffold` が書くプレースホルダーのままの step には、そのファイルを示す注記が 1 つ付きます。
  `--fail-on` がこの code を名指さない限り、終了コードは変わりません。
  素の `nuka tend` の注記を 1 つでも失敗とみなすジョブやスクリプト、または `ok: nothing to tend` を待つものには、そうした step ごとに注記が 1 つ現れます。
  各 step の `description` に、その step が何をするかを書いてください。
- **`nuka mcp-tools` は `nuka experimental mcp-tools` になりました。**
  フラグも出力も同じです。
  古い綴りは終了コード 1 で終わり、新しい綴りを示します。
  そのため、`nuka mcp-tools -- <command>` を実行していた script は `nuka experimental mcp-tools -- <command>` に変えてください。
  `experimental` の下にあるため、その形は後のリリースで、非推奨の告知なしに変わることがあります。
  0.17.0 はどちらの綴りも削除します。
  「0.16.1 から 0.17.0 へ」を参照してください。

`nuka run` が `nuka check` の拒否するものを拒否するようになりました。
`check` が error を報告する feature を実行しているプロジェクトは、対応が必要です。

**`nuka run` は先に静的チェックを行います。**
`nuka run` は何かを実行する前に、選んだ scenario について `nuka check` が報告する内容を報告します。
その中に error が 1 つでもあれば、error を stderr に出力し、record を書かずに 1 で終了します。
対応は次のとおりです。

- **`nuka check && nuka run features` とつなげた script はそのまま動きます。**
  check が 2 回走るので、step の discovery が 1 回分増えます。
  `nuka run` だけに縮めることもできます。
  対象を渡さない `nuka run` は、今は `featuresDir` を実行します(以前は対象を求めて 1 で終了していました)。
  `additionalFeatureDirs` に feature を置いているなら、別の `nuka check` を残してください。
  対象を渡さない `nuka run` はそれを辿りません。
- **`nuka check` が拒否する feature は、もう実行されません。**
  指摘を直すか、意図して実行するときは `--no-check` を渡してください。
  たとえば移行中のスイートに `undefined-step` がまだ残っているときです。
  `duplicate-pattern` や import に失敗する step ファイルのような run 全体に関わる error は、それに触れる scenario だけでなく、プロジェクトのすべての `nuka run` を止めるようになりました。
- **こうした error の実行時の失敗に合わせていた script は、拒否の方を見ることになります。**
  未定義の step は以前は record 付きでその scenario を失敗させていました。
  今はどの scenario も実行されず、stderr には `nuka check` の行が出ます。

`playwright` は nukadoko と一緒にはインストールされなくなりました。
ブラウザや HTTP の step を持つプロジェクトは対応が必要です。

**Playwright は optional な peer dependency になりました。**
Playwright と `playwright-core` はインストールの大半を占めていて、`page`、`context`、`request` を一度も使わない step だけのプロジェクトには不要でした。
nukadoko は今、`playwright` を optional な peer dependency として宣言し、そうした fixture のどれかが初めて構築されるときにだけ読み込みます。
対応は次のとおりです。

- **`page`、`context`、`request` を使う step か fixture を持つプロジェクトは、`playwright` を自分の `devDependencies` に追加します。**
  バージョンは nukadoko がテストしているものに正確に合わせます: `npm install -D -E playwright@1.61.1`。
  入れていなければ、`nuka check` が、その step とこのコマンドを名指す 1 行で `playwright-missing` を報告します。
  ほかの `nuka check` の error と同じく、`nuka run` はどの step も実行する前に止まります。
  `nuka run --no-check` なら実行し、最初のそうした step が同じ行を出して失敗します。
  `nuka experimental webmcp-tools` も同じく `playwright` を必要とします。
- **CI の変更は `package.json` のその 1 行だけです。**
  `playwright` がプロジェクトの devDependency になれば `npm ci` がそれをインストールし、`npx playwright install --with-deps chromium` はブラウザの step を実行する job でこれまでどおりブラウザをダウンロードします([docs/ci.ja.md](ci.ja.md) のとおりです)。
  `nuka check` だけを実行する job や、ブラウザの step を持たないプロジェクトは、ブラウザのインストール行を消してかまいません。
- **ブラウザの step も HTTP の step も持たないプロジェクトは、`skipLibCheck` の値によらず `playwright` なしで型チェックが通ります。**
  nukadoko 自身の型宣言は、`page` と `request` の fixture のために Playwright の `Page` と `APIRequestContext` を名指しています。
  `playwright` が無いとき、それらの型は `any` になり、`tsc` は通ります。
  インストールされていれば、それらは Playwright 自身の型です。
- **自分の `playwright` が別の版のプロジェクトは、それを 1.61.1 に固定します。**
  npm は別の版の `playwright` の横に nukadoko をインストールすることを拒否します(`ERESOLVE`)。
  以前は 2 つ目のコピーをインストールしていました。

## 0.14.1 から 0.15.0 へ

`nuka accept` と sign-off の所見はすべて削除されました。
feature に sign-off しているプロジェクトや、CI を sign-off でゲートしているプロジェクトは対応が必要です。
compat の修正で、上げる前に知っておくものがあります。
redact の変化も 1 つあります。
evidence の名前の変化も 1 つあります。
env file のパーサは、コメント、引用符、エスケープ、複数行にまたがる値について、dotenv に従うようになりました。
古い読み方に依存していた env file があるプロジェクトは、次の実行の前に、その値を確認してください。

`nuka session clear --env` と `nuka session stop` も、以前は終了コード 0 で何も出さなかった打ち間違いを名指すようになりました。
Allure と messages の emitter は既定で無効になりました。
どちらかの export を読むプロジェクトは対応が必要です。

**`nuka accept` は無くなり、run サマリがそれを置き換えます。**
それが書いた記録を残し続けたプロジェクトはありませんでした。
run サマリが同じ主張(「このコミットで green」)を、そのコミットに結び付いた証跡として運び、承認そのものはチームが承認を記録する場所に記録されます。
すべての `nuka run` がそのサマリを書くようになりました。
pull request に投稿する方法は [docs/ci.ja.md](ci.ja.md) にあります。
やることは次のとおりです。

- **スクリプトと CI から `nuka accept` を取り除きます。**
  コマンドはもう存在しないので、`nuka accept <feature>` は yargs の unknown argument のエラーで 1 を返して終わります。
  0.16.1 の次のリリースからは、すべての拒否と同じく 2 を返します。
  green の `nuka run` の後でジョブがそれを実行していたところでは、代わりに run サマリを投稿します。
  `nuka run <features> --summary <path>` を実行し、そのファイルを pull request にコメントする step を続けます([docs/ci.ja.md](ci.ja.md) の workflow にあります)。
- **feature に sign-off の記録があるかを見る PR の検査を置き換えます。**
  変更された各 feature の隣に `<feature>.*.md` のファイルを探すジョブや、`nuka tend --fail-on feature-never-signed` を実行するジョブには、もう確かめるものがありません。
  レビュアーは差分の中の `.feature` と pull request 上の run サマリを読みます。
  run が証跡であり、承認をどこに記録するかはチームのプロセスです(docs/spec.ja.md の「レビュー」を参照)。
  削除された code(`feature-never-signed`、`signed-feature-unscanned`、`signoff-condition-mismatch`、`signoff-feature-changed`、`signoff-feature-missing`、`signoff-record-old-format`、`signoff-record-unreadable`、`signoff-result-invalid`、`signoff-step-missing`)のどれかを付けた `nuka tend --fail-on` は、何も解析する前に 1 で終わります(0.16.1 の次のリリースからは 2 で終わります)。
  stderr はその code を名指し、run サマリが置き換えたと述べます。
  フラグを外すか、`nuka tend` がまだ報告する code でゲートしてください。
- **古い `*.feature.*.md` の記録は何もしません。**
  もう何もそれを読みません。
  `nuka tend` はそれについて何も言わず、`oaths` が名指さない限り scenario にもなりません。
  削除しても、履歴として残してもかまいません。
  どちらも安全です。
- **`nuka tend` は `--fail-on` が発火しない限り 0 で終わります。**
  以前の唯一のエラーは古くなった sign-off でした。
  今は所見がすべて note で、`--json` は `errors` を空の配列として保つので、そのフィールドを読む側は変える必要がありません。
- **`:line` の run が stderr に出す告知が変わりました。**
  以前は、部分実行は accept できないと述べていました。
  今は、run サマリが選んだ scenario しか扱わないと述べます。
  古い文に一致させていたスクリプトは、新しい文に一致させてください。

- **`nuka tend --json` は fixture の名前を `step` ではなく `fixture` に入れます。**
  `fixture-unused` と `fixture-touches-app` の note は、以前は fixture の名前を `step` に入れていました。
  今は新しい `fixture` フィールドに入れ、`step` は設定しません。
  これらの note を `.step` で選んでいたスクリプトは、`.fixture` で選んでください。
  テキスト出力は変わりません。
- **`this.link` の第 2 引数は表示名ではなく、もう 1 つの URL です。**
  `this.link(a, b)` は以前、名前が `b` である link を 1 件記録していました。
  今は引数ごとに `declared` の link を 1 件記録し、どれにも名前は付きません。
  これは cucumber-js が URL のリストを扱うのと同じです。
  表示名を渡していた呼び出しは、その引数を削ってください。
  allure の `link(url, name)` は変わりません。
  その名前はこれまでどおり `declared` の link に残ります。
- **`this.attach` は cucumber-js の payload の形に従うようになりました。**
  `base64:` の media type は、ファイルに書く前に復号されます。
  `{ mediaType, fileName }` はそのファイル名を使います。
  readable stream は読まれ、呼び出しは step が await しなければならない promise を返します。
  以前の base64 のテキストや、stream オブジェクトの JSON を attachment ファイルから読んでいたプロジェクトは、これからは復号したバイトか stream の中身を読みます。
- **`defineWorld` は `page` と `request` を拒みます。**
  これらの名前は harness の getter です。
  どちらかを宣言していると、以前は `nuka check` を通過したあと `nuka run` が `WorldNotOpenedError` で落ちていました。
  `defineWorld` からそのキーを取り除いてください。
  サブクラスは `this.page` と `this.request` を、これまでどおり代入できます。
  `await this.openPage()` と `await this.openRequest()` は変わりません。
  残った宣言は、`nuka check` が `step-file-import-failed` として報告し、`nuka run` が同じメッセージで止まります。
  そのメッセージはフィールド名を含みます。
- **読み込んだ secret のエンコードされた形は record から消え、2 つのキーが新たに衝突することがあります。**
  パーセントエンコードされた形と JSON エスケープされた形は、読み込んだ値そのものと同じく `{{secret.NAME}}` に置き換わります。
  record からエンコードされた secret を探していた script は、漏れていた値を読んでいました。
  今は token が見つかります。
  読み込んだ値そのものと、その形の一方である 2 つのオブジェクトキーは、redact すると 1 つの文字列になり、`redact` は片方を捨てる代わりに両方のキーを名指して throw します。
  数値の secret と数として等しい JSON の数値は、変わりません。
  config で動かすものはありません。
- **`ctx.evidence.attach` と `ctx.evidence.path` は、harness のファイル名を拒否します。**
  `record.json`、`final.png`、`trace.zip`、`http.jsonl` は `ReservedEvidenceNameError` を投げるようになりました。
  大文字小文字だけが違う綴りも同じです。
  そのいずれかを attach して、そのパスを読み戻していた step は、別の名前を選ぶ必要があります。
  それ以外で大文字小文字だけが違う 2 つの名前は、同じ名前を 2 回使ったときと同じように、2 つのファイルとして残ります。
  2 つ目は拡張子の手前に `-2` が付きます(`Report.txt` の次は `report-2.txt`)。
  大文字小文字を区別するボリュームでは、この 2 つの名前は以前は 2 つのファイルでした。
  区別しないボリュームでは以前は 1 つのファイルで、最初の中身は失われていました。
- **引用符で囲まない値の `#` はコメントです。**
  `TOKEN=abc123 # rotated` は、以前は `abc123 # rotated` を読み込んでいました。
  今は `abc123` を読み込みます。
  `#` の前に空白は要りません。
  値の中に `#` を残すには、値を引用符で囲みます。
- **二重引用符は `\n` と `\r` を展開します。**
  `KEY="line1\nline2"` は、以前は `\` と `n` の 2 文字を読み込んでいました。
  今は改行を読み込みます。
  一重引用符とバッククォートはエスケープを展開しないので、バックスラッシュを残すときはそちらを使います。
  `\n` の直前のバックスラッシュは特別ではありません。
  二重引用符の中の `\\n` は、バックスラッシュと改行です。
- **引用符で囲んだ値は複数行にまたがれ、バッククォートは引用符です。**
  複数行に書いた秘密鍵は、以前は分割され、その中の行が別のキーになることがありました。
  その secret は `ctx.env` にも secret set にも入りませんでした。
  今は 1 つの値です。
  `` KEY=`backtick` `` は、以前はバッククォートの文字を残していました。
  今は `backtick` を読み込みます。
- **`nuka check` は `env-file-skipped-line` という warning を出します。**
  報告が名指しするのはファイルと行番号であり、テキストではありません。
  実行は、読めた代入をそのまま読み込みます。
  この warning だけでは `nuka check` は失敗しません。
  代入ではなかった行は、以前から読み込まれていませんでした。
  warning は、それを見えるようにするものです。
  区切りは `=` です。
  `:` を使う行は、この warning になります。
- **`nuka session clear --env <name>` は、config が定義していない environment を、その下に session ファイルが残っていないときに拒否します。**
  以前は終了コード 0 で何も出さなかったので、打ち間違いは session が消えたように見えました。
  メッセージは `nuka do --env` がすでに使っているものと同じです。
  config から外した environment の下に残っている session ファイルは、今までどおり削除され、コマンドは終了コード 0 のままです。
  stderr はその environment を名指します。
  `--env` を省いた場合は変わりません。
  暗黙の `default` environment を削除し、それは config に載っている必要はありません。
- **存在したことのない名前に対する `nuka session stop <name>` は、終了コード 0 のまま、stderr に 1 行出すようになりました。**
  その行は session と environment を名指します。
  stderr に何か出ただけで失敗とみなすスクリプトは、その行を見ます。
  生きている session を止める場合と、古びた lock file を片付ける場合は変わりません。
  成功時は今までどおり静かです。
- **`returns` は省略できるようになり、`nuka scaffold` は `--pattern` と `--then` を受け取ります。**
  プロジェクトにすでにあるものの意味は何も変わりません。
  `returns` を宣言した step は、今までどおりその schema が検証する値を返す必要があります。
  引数 1 つの `run({ page })` は、今までどおり fixture を名指します。
  `returns` が `z.object({})` の step は、その行と `return {}` を消せますが、消す必要はありません。
  `if` の中の早期の `return {}` は `return;` にします。
  消すと、step はその後のコードへ進みます。
- **Allure と messages の emitter は、config にそのキーがあるまで無効です。**
  以前の `nuka run` は、設定なしで `.nukadoko/export/allure-results/` と `.nukadoko/export/messages.ndjson` を書いていました。
  Allure の result を読むプロジェクトは、`nukadoko.config.ts` に `allure: {}` を追加します。
  cucumber messages を formatter や JUnit ベースの CI に渡すプロジェクトは、`messages: {}` を追加します。
  すでに `allure.resultsDir` や `messages.output` を設定しているプロジェクトは、キーがすでにあるので何も変える必要はありません。
  どちらも読まないプロジェクトは、`allurerc.mjs` と export ディレクトリを消して構いません。
  以前の run が書いたものは、今までどおり `nuka clean --export` で消せます。
  0.16.1 の次のリリースからは `--export` は 2 で終了し、素の `nuka clean` が export を record と cache と一緒に消します。
- **`nuka init` が書くものは減り、つなぐものは増えました。**
  `--allure` や `--env` で求めない限り、`allurerc.mjs`、result のディレクトリ、`.gitignore` の `.env` の行を書かなくなりました。
  また、`package.json` に `test:scenarios` script を追加します。
  変わるのは新しく `init` したときに書かれるものだけで、すでに初期化したプロジェクトは何もする必要がありません。

**0.14.x 以前から上げたあとの任意の作業。**
プロジェクトが手で書くことの多かった 3 つのものが、0.15.0 から組み込まれています。
`nuka check` と `nuka run` は手書きのものを受け付けるので、消すまで何も失敗しません。
0.16.1 の次のリリースからは、`nuka tend` が 1 つ目を `fixture-replaces-builtin` として報告します。

- **`scratch` は builtin の fixture です。**
  `scratch.dir(prefix)` と `scratch.copy(source)` でやっていたことが足りるなら、`config.fixtures` の `scratch` エントリとその `StepFixtures` の宣言は消せます。
  どちらも新しい一時ディレクトリを返します。
  そのディレクトリは scenario が終わると成否にかかわらず消え、step record の `evidence.scratch` に載ります。
  プロジェクト自身のエントリがある間は、それが builtin を置き換えます。
- **`runCommand` が `spawnSync` のラッパーと、`execFileSync` や `execSync` の呼び出しを置き換えます。**
  `import { runCommand } from "nukadoko"` として、`await runCommand(command, args, { cwd, env, input, timeout })` と呼びます。
  step の中の呼び出しは、それぞれ step record の `observed.processes` にエントリを足します。
  `spawnSync` との違いが 2 つあり、見落とすと run が失敗します。
  1 つ目に、Promise を返すので、呼び出し側はそれぞれ `await` を足し、`async` になります。
  `await` のない呼び出し側は `nuka check` を通り、実行時に `returns validation failed` で失敗します(`tsc` が先に報告します)。
  2 つ目に、`exitCode` は `number | null` で、signal がプロセスを終わらせたときは `null` です。
  そのため `returns` に `exitCode: z.number()` を宣言する step は、`exitCode ?? 1` を返すか、`z.number().nullable()` と宣言します。
  失敗した run が `used <step> exit <code> <first stderr line>` の行を出すのは、プログラムを動かした step が `exitCode` と `stderr` の両方を返すときだけです。
  3 つ目の違いは `execFileSync` と `execSync` に当てはまり、見落としても何も失敗しません。
  それらは 0 以外の終了で throw しますが、`runCommand` は resolve します。
  その throw を assertion として頼っていた step は、プログラムが失敗しても pass し、`nuka check` も green のままです。
  プログラムの成功が必要な step では、`if (exitCode !== 0) throw new Error(stderr)` のように終了コードを自分で確かめます。
  `runCommand` が返すのは stdout の文字列ではなく `{ exitCode, signal, stdout, stderr }` です。
  また `runCommand` はシェルを通さないので、`execSync` の文字列はコマンドと引数に分けます。
- **空の `returns` は消せます。**
  `returns` が `z.object({})` の step は、その行と最後の `return {}` を消して構いません。
  `if` の中の早期の `return {}` は `return;` にします。
  消すと、step はその後のコード(たとえば次の assertion)へ進みます。

## 0.14.0 から 0.14.1 へ

- **`nuka check` が、エラーの `outline-does-not-run` を新たに報告することがあります。**
  Examples の表が無い Scenario Outline と、見出し行だけで本体の行が無い Examples の表は、以前は `check` を通りました。
  前者はプレースホルダの文字列を残したまま 1 回実行され、後者は scenario を 1 つも生みませんでした。
  実行しなければならない場合ごとに Examples の行を足すか、空の Examples の表を削除します。
  0.14.0 で green だった `check` が 0.14.1 で red になる理由は、これだけです。

## 0.12.0 から 0.13.0 へ

上げる前に知っておく挙動の変化があります。

- **20 分を超えて走る typed step は、失敗するようになりました。**
  以前は無制限に走り、run 全体を道連れにしていました。
  制限は `nukadoko.config.ts` の `stepTimeout` で、1 つの step は `defineStep({ timeout })` で自分の値を持てます。
  このプロジェクトに、正当にそれより長くかかる step があるなら、上げる前に数字を設定してください。
  失敗の見え方は `error.kind: "timeout"` を持つふつうの step の失敗です。
  「制限なし」を意味する値はありません。
  compat step は影響を受けません。
  glue 自身が `{ timeout }` を宣言するか `setDefaultTimeout` を呼ばない限り、無制限で走ります。
- **`--concurrency <n>` の run は、scenario ごとに 1 行増えます。**
  開始時に worker と scenario を名指す行です。
  既存の `scenario <n>/<total>` の行を拾っている script は影響を受けません。
  `scenario ` で始まる行をすべて拾っているものは、両方を見ることになります。
  `--quiet` はどちらも抑えます。
- **default export が無い config ファイル、または default export が Promise の config ファイルは、失敗してそのファイルを名指すようになりました。**
  以前は `{}` として読まれ、ファイルに書いたキーは無視されていました。
  オブジェクトを export してください: `export default defineConfig({ ... })`。
- **読めない env file、またはそのパスにあるディレクトリは、setup を止めるようになりました。**
  以前は読み飛ばされ、最初の `requireEnv` がキーを責めていました。
  拒否は、設定されたパスと errno を名指しします。
  ディスク上にないパスは、これまでどおり何も寄与せず、`nuka check` はその欠落を警告します。
  読み飛ばしに依存していた run があるなら、上げる前にパスか権限を直してください。

## 0.11.0 から 0.12.0 へ

追加がいくつか、修正が 1 つ、名前が 1 つです。

- **新しい acceptance record の名前は `<feature のファイル名>.<date>-<sha>...` で、拡張子を含みます。**
  既に書かれた record は古い名前のまま、そのまま読めます。
  record を名前で読むものはありません。
  `<ベース名>.*.md` で glob するスクリプトは両方の形に一致します。
  `<ベース名>.20*.md` で glob しているものは古い形にしか一致しないので、`<ベース名>.feature.*.md` も足してください。
- **1 つの step が、同じ行で 1 つのキーを `from` から、もう 1 つを table や docstring から受け取れます。**
  `table-docstring-key-mismatch` を避けるために chain するキーを optional にしていたスイートは、required に戻せます。
  その step の from-order の検査が戻ります。
- **`nuka run --repeat <n>`、`nuka tend --fail-on <code>`、Condition 節の declared vs observed の件数**は追加で、既にあるものは変わりません。

## 0.10.1 から 0.11.0 へ

`nuka run` が古い record を自分で消すようになり、trace ファイルはディスク上に 2 つではなく 1 つになりました。

- **アップグレード後の最初の `nuka run` が、最新 20 回より古い run をすべて消します。**
  run は既にディスクにある scenario record から読み取るので、何週間も育った state directory はその最初の run の終わりに縮み、run は消した run の数を 1 行の `retention:` として出力します。
  それを望まないなら、走らせる前に `nukadoko.config.ts` の `retention.runs` を設定します。
  「すべて残す」値はなく、あるのは大きな数字だけです。
  `retention.adHocDays`(既定 7)は、`nuka do` の record のような、どの run にも属さない record の寿命で、別の設定です。
- **`nuka accept` と `nuka tend` は、保持された run だけを見ます。**
  最後の green な run が最新 `retention.runs` 回より古い feature は、一度も走っていないものとして読まれます。
  accept する前にもう一度走らせてください。
  既に書かれた sign-off record は影響を受けません。
  feature の隣にあり、`.nukadoko/` の下にはないからです。
- **`nuka do --use <id>` と `nuka harvest <id>` が、以前は解決できた id を拒否することがあります。**
  拒否の文面は、record が寿命を過ぎた可能性と、有効な方針を述べます。
  「no such step record」だけでは終わりません。
- **0.10 以前が書いた `allure-results/` は刈られません。**
  retention が export ファイルを消すのは、書いた run が `.nukadoko/records/runs/<run_id>/` に残した一覧を通してだけで、古い run はそれを残していません。
  以後の run は寿命を過ぎたときに自分のファイルを自分で消すので、永久に残るのは上げる前に書かれたものだけです。

  `nuka clean --export` はディレクトリ全体を空にします。
  上げてから保持している run のレポートも一緒に消えます。
  (0.16.1 の次のリリースからは `--export` は 2 で終了し、素の `nuka clean` は record と cache も消します。)
  それを残したいなら、上げた日より古いものだけを消してください。
  どちらにせよ、それらを追跡しているものはありません。

  ```sh
  find .nukadoko/export/allure-results -type f ! -newermt '<上げた日>' -delete
  ```
- **`allure-results/` の下の trace と screenshot は、`records/steps/<id>/` の下のファイルへの hard link になりました。**
  読む側には何も変わりません。
  link を保たないツールで `.nukadoko/` をコピーすると、以前と同じく 2 つのファイルに戻ります。
  `allure.resultsDir` が別のファイルシステムにあるときは、自動でコピーに戻ります。
- **`nuka clean --records` は `.nukadoko/records/runs/` も消します。**
  パスを指定して clean をスクリプトにしているプロジェクトは、このディレクトリを含めてください。
  0.16.1 の次のリリースからは `--records` は 2 で終了し、素の `nuka clean` が record、cache、export をまとめて消します。

## 0.10.0 から 0.10.1 へ

修正が 1 つ。
プロジェクト側から見える変化が 2 つあります。

- **record のオブジェクトのキーが、以前と違って読めることがあります。**
  `redact` はオブジェクトの値だけを歩き、キーはそのまま写していました。
  そのため、キーの中に書かれた秘密は step record にそのまま着地していました。
  いまはキーにも同じ置換が掛かります。
  秘密を含むキーで record を読んでいたスクリプトは、これまで漏れた秘密を読んでいたことになります。
  その位置は `{{secret.NAME}}` になります。
  record の他の部分は動きません。
  キーの形が型で決まっているフィールドは、もともと秘密をキーに持ちません。
- **`redact` が、以前は黙ってデータを捨てていた場所で throw するようになります。**
  2 つの異なるキーが、伏せたあとに同じ綴りになることがあります。
  以前のコードは後のキーが前のキーを上書きし、その下の枝ごと消していました。
  いまは両方のキーを名指して throw します。
  ここに到達する形は、一方のキーがデータとしてそのまま `{{secret.TOKEN}}` と書かれていて、隣のキーがその token が指す生の値を持っている場合です。
  この形を踏んでいた run は、このリリースより前は、何も言わずにデータを失っていました。

## 0.9.0 から 0.10.0 へ

`nuka run` が stderr に書くものが増え、`nuka tend` は新しい所見を 1 つ報告します。
理由は [CHANGELOG.md](../CHANGELOG.md) の `## 0.10.0` にあります。

- **`nuka run` は、サマリ行の後ろで、失敗した scenario を名指します。**
  通らなかった scenario 1 つにつき 1 行で、feature のパス、行、名前を出します。
  `--quiet` は、サマリを残すのと同じ理由でこれらの行も残します。
  このコマンドの stderr を解析しているものには、これまで無かった行が見えます。
  stdout は変わりません。
  1 行 1 件の scenario record のままであり、解析すべきチャネルもそちらのままです。
- **`nuka tend` に `repeated-scenario-prefix` の所見が増えます。**
  sign-off の staleness 以外のすべての tend の所見と同じく、exit code を変えません。
  tend の exit status で動く定期ジョブに影響はありません。

## 0.8.0 から 0.9.0 へ

acceptance record には破壊的変更が 1 つあります。
`nuka tend` の `post-navigation-read` の note も、いまは違う場所を読みます。
なぜそう変わったかは [CHANGELOG.md](../CHANGELOG.md) の `## 0.9.0` にあります。

- **これから `nuka accept` が書く記録は、各 step から `actions`、`page_events`、`sections`、`polls`、`declared`、`http_omitted`、`truncated` を外します。**
  新しく accept された記録を読むスクリプトは、これらのキーを期待しないようにする必要があります。
  これらはどれも `.nukadoko/` の下にある step record にはこれまでどおり残ります。
  絞り込まれるのは、commit される記録に埋め込まれるコピーだけです。
  commit された記録自身の本文が、外した key それぞれの名前を記します。
  読み手が推測する必要はありません。
- **すでに commit された記録は、変わらず動き続けます。**
  既存の acceptance record を読むのに変更は要りません。
- **これから書かれる記録では、各 scenario が要約表も運びます**: step、status、ms、mutates、reads、writes です。
- **`nuka tend` の `post-navigation-read` の note は、いまは commit された記録ではなく、`.nukadoko/records/steps/` にある step record を読みます。**
  プロジェクト側でやることはありません。
  ある step についてこの note を再び得たければ、その feature を再実行してください。

## 0.7.0 から 0.8.0 へ

Allure のレポート構造には 1 つの破壊的変更があります。
もう 1 つの挙動変更は `nuka tend --json` の利用者に影響します。

- **Allure は scenario の pickle ごとに 1 つの result を書くようになりました。**
  Gherkin の step はその result の中の entry です。
  Suites タブは `parentSuite` と `suite` で result をまとめなくなったため、保存済みの Suites 表示はフラットになります。
  Feature は `feature` label を使って Behaviors タブで探すか、result の `titlePath` 階層を使ってください。
  通常の scenario は既存の history を継続します。
  Scenario Outline の各行は Examples のセルが可視 parameter になったため、1 回だけ新しい history を始めます。
  ライブレポートは各 step の完了後も更新されますが、一時的な progress snapshot が更新を提供します。
  ライブ視聴中は、進行中の scenario のリトライに以前の unknown snapshot が見えることがあります。
  nukadoko は scenario の終了時にそれらを削除するため、run 後に生成したレポートには現れません。
  run の途中で `allure-results` を読むものは、`*-progress-result.json` を一時ファイルとして扱う必要があります。
  完了した run の後には、このファイルは存在しません。

- **`nuka tend` の `post-navigation-read` の note がまとめられました。**
  以前は step record 1 件につき 1 つの note を出していました。
  そのため Background の step は、シナリオが 24 本あるスイートでは、ファイル名だけが違う 24 個の note になっていました。
  step と、そのナビゲーション呼び出しと、その直後の呼び出しが同じものは、いまは 1 つの note にまとまります。
  その note は、何件の step record で起きたかと、gap がどの範囲に収まったかを持ちます。
  note の数を数えて発生回数を数えていたスクリプトは、これからは種類の数を数えることになります。
  発生回数は note の文面の中にあります。

## 0.6.0 から 0.7.0 へ

破壊的変更が 1 つ、加えて破壊的ではないものの知っておく価値のある挙動の変化が 1 つあります。
後者が変わるのは、`nuka run` の出力を見張っているスクリプトが実際に目にするものだからです。
破壊的なほうについて、なぜそう変わったかは [CHANGELOG.md](../CHANGELOG.md) の `## 0.7.0` にあります。

- **step のスキーマが宣言していない args キーは、いまや黙って捨てられるのではなく拒否されます。**
  `nuka describe` はすでに各オブジェクトスキーマ自身の `additionalProperties: false` を公開していました。
  実行時はいま、step を呼べるあらゆる経路で同じ形を強制するようになりました: `nuka do`、`nuka do --session <live>`、`nuka run`、`recordStep`、そして part が呼ばれる `call` fixture です。
  `from` や `--use` が埋めるキーは決して指摘されません。
  どちらも、その step がすでに宣言したキーしか名指せないからです。
  **成功した step record 自身の `args` も形が変わりました。**
  いまはスキーマで検証済みの値であり、生の値ではありません。
  スキーマ自身の `.default(...)` が埋めたキーは、呼び出し側が一度も書いていなくてもそこに現れます。
  step record の `args` を送った内容と突き合わせるスクリプトは、これを織り込む必要があります: 足された default は何かが壊れた印ではありません。
  失敗した record はこの影響を受けず、part 自身の `CallEntry.args` もどちらの結果でも生のままなので影響を受けません。
- **破壊的ではありませんが、知っておく価値があります: `nuka run` はもう run の進行中に `messages.output` へ直接書き込みません。**
  各呼び出しはいま、設定されたパスの隣にある自分自身のファイル(設定されたパス自身の名前に run id を差し込んだもの。
  既定のパスなら `messages.<run_id>.ndjson`)に書き込み、run が終わった時点で初めて、原子的に設定されたパスを置き換えます。
  この変更は本物のバグを閉じています: 同じパスに対する 2 つの `nuka run` の呼び出しが、以前は 1 つの壊れたファイルへ互いに割り込み合っていました。
  run をライブで見るために `messages.ndjson` を tail していたスクリプトは、いまは run が終わるまで何も目にしません。
  ライブで見るには代わりに Allure(`npx allure watch`)を使ってください。
  ファイルが truncate されたことを「run が始まった」の合図にしていたスクリプトは、別の合図が必要です。
  設定されたパスはいま、その run 自身が終わるまで触れられないからです。
  `messages.output` は結局どちらの場合も、直近に完了した run 自身のストリームを保持することになるので、run が終わったあとにだけそれを読むものは何も変える必要がありません。
  housekeeping に 1 つ足すことがあります: 各 run 自身のファイルはいま設定されたパスの隣に積み上がり、消えるのはこのリリースで加わったもう 1 つの新しいコマンド `nuka clean [--export]` を叩いたときだけです(コマンド自身の `--help` を参照)。

## 0.4.1 から 0.5.0 へ

追加のみで、狭い例外が 1 つあります。
なぜそう変わったかは [CHANGELOG.md](../CHANGELOG.md) の `## 0.5.0` にあります。

- **`Step` はいまや常に `parts` を持つため、手で書いた `Step` のオブジェクトリテラルは型検査を通らなくなりました。**
  `Step` は export された型で、`parts` は `from` がすでにそうであるのと同じように必須です。
  そのため、どの読み手も先に `undefined` かどうかを確認せずに走査できます。
  `defineStep` で作った `Step` は影響を受けません。
  `Step` に注釈を付けるだけ、あるいは受け渡すだけのコードも同様です。
  壊れるのはただ一つ、オブジェクトを手で組み立てている場合だけで、その典型的な理由はテストダブルです。
  `parts: []` を足してください。
  あるいは、`defineStep` で作るほうがよいです。
- **他に何もする必要はありません。**
  step record は任意の `calls` フィールドを新たに持つようになりました。
  `nuka steps --json` と `nuka describe` は `parts` を新たに持つようになりました。
  `needs` / `needs_browser` はいまや step の part の分を含むようになりました。
  フィールドの改名も削除もないため、既存の acceptance record は有効なままで、どちらの JSON を読むスクリプトもそのまま動きます。

## 0.3.0 から 0.4.0 へ

破壊的変更は 1 つです。
加えて、破壊的ではない対応が 1 つあります。
各項目は「何を直すか」だけを述べます。
なぜそう変わったかは [CHANGELOG.md](../CHANGELOG.md) の `## 0.4.0` にあります。

- **step record と scenario record の、id を持つフィールド名がまた変わり、いまは 1 つの規則に従います: `<粒度>_record_id`、または run の `run_id` です。**
  どちらの JSON を読んでいたスクリプトも、現在の名前を読む必要があります: step record の `record_id` は `step_record_id` に、step record 上の所属 scenario record の id(旧 `scenario`)は `scenario_record_id` に、scenario record 自身の `scenario_id` は `scenario_record_id` に、scenario record の `steps[].record` は `steps[].step_record_id` になりました。
  scenario record 自身の `scenario` フィールド(id ではなく pickle の名前)と `run_id` は変わっておらず、`step-` / `scn-` / `run-` という id の接頭辞も変わっていません。
  既存の acceptance record は作り直しが要ることがあります: `nuka run` でその feature を再実行し、`nuka accept` し直してください。
  自分の record が対象かどうかは、上げる前に `nuka tend` を実行すれば分かります。
  実際に対象となる acceptance record だけを名指しし(`signoff-record-old-format`)、`featuresDir` の中にある feature については何も名指ししません。
  その feature は無人で走っており、保証を持っているのはもう sign-off ではないからです。
  旧い、裸のままだった箇所がもう 2 つあり、いまは同じ規則に合わせました。
  step record の `used[]` の各エントリは、以前は上流の id を `record` という名前で運んでいました。
  これを読んでいたスクリプトは、いまは `used[].step_record_id` を読む必要があります。
  また、Allure emitter の step パラメータで以前は `"record"` とだけ名付けられていたものは、いまは `"step record id"` です。
  Allure の出力をパラメータ名で読んでいたスクリプトは、新しいラベルを読む必要があります。
- **破壊的ではありません: step record はいまや `run_id: string | null` も持ちます。**
  読まなくても何も壊れません。
  ある step record がどの run に属するかを、隣の scenario record を先に開かずに知りたいスクリプトは、代わりにこのフィールドを読めます。

## 0.2.0 から 0.3.0 へ

破壊的変更は 5 つです。
加えて、破壊的ではないものの、新しい機能に乗るために必要な対応が 1 つあります。
各項目は「何を直すか」だけを述べます。
なぜそう変わったかは [CHANGELOG.md](../CHANGELOG.md) の `## 0.3.0` にあります。

- **step record の JSON は、フィールド名と id 接頭辞が変わりました。**
  step record や scenario record の JSON を読んでいたスクリプトは、現在の名前を読む必要があります: `receipt_id` は `record_id` に、id の接頭辞は `rcpt-` から `step-` に、`used` エントリの参照先フィールドは `receipt` から `record` になりました。
- **`.nukadoko/` はいまや目的別に 3 つのディレクトリ、`records/`、`export/`、`cache/` に分かれます。**
  step record 自身のディレクトリはいまや `records/steps/<id>/` の下に、scenario record は `records/scenarios/<id>/` の下にあります。
  Allure emitter と messages emitter はいまや `export/` の下に書きます。
  session はいまや `cache/sessions/` の下にあります。
  `.nukadoko/` は gitignore された作業状態なので、古いディレクトリはそのまま消してかまいません。
  次の `nuka run` が新しい配置を書くので、そこから何かを移行する必要はありません。
- **`--use` はいまや `step-...` という id を取ります。**
  このリリースより前に発行された id は、ツールがもう読まない配置のディレクトリを指します。
  生産元の step(`nuka do` または `nuka run`)を再実行して、現在の形の id を取り直してください。
- **既存の acceptance record は作り直しが要ることがあります。**
  上げる前に `nuka tend` を実行して、答えさせてください。
  実際に対象となる acceptance record だけを名指しし(`signoff-record-old-format`)、`featuresDir` の中にある feature については何も名指ししません。
  その sign-off の報告は 0.3.0 でやめたためです。
  名指しされたものについては、`nuka run` でその feature を再実行し、`nuka accept` し直してください。
- **`nuka tend` は、すでに `featuresDir` の中にある feature については、もはや stale な sign-off も、ずれた条件も報告しません。**
  そのような feature についてこの所見に頼っていたプロジェクトは、その効き目が移ったと考えてください: すでに無人で実行され続けているその feature の `nuka run` こそが、いまは同じことを確認します。
  `signoff-record-unreadable` は影響を受けません。
  どちらの場合もコードの変更は要りません。
- **破壊的ではありませんが、乗るためには必要です: 自分自身の `allurerc.mjs` を持つプロジェクトは、Allure の history、trend、run をまたいだ flaky 検出を scenario 粒度で得るために `historyPath` を手で足す必要があります。**
  これが無くても何も壊れません。
  このリリースより前と同じです。
  新しく増えた scenario レベルの Allure test result が、それらの画面に出てこないだけです。
  既存の `categories` の配列と並べて `historyPath: ".nukadoko/export/allure-history.jsonl"` を足してください(`nukadoko.config.ts` の `stateDir` を変えている場合はそれに合わせて調整してください)。
  `examples/allure/allurerc.mjs` にこのフィールドの実例があります。
  このリリースで `nuka init` を実行して作ったプロジェクトには、すでに入っています。

## 0.1.0 から 0.2.0 へ

破壊的変更は 3 つです。
各項目は「何を直すか」だけを述べます。
なぜそう変わったかは [CHANGELOG.md](../CHANGELOG.md) の `## 0.2.0` にあります。

- **`nuka steps --json` のトップレベルは、素の配列から `{ steps, import_failures }` に変わりました。**
  旧来の素の配列を読んでいたものは、いまや `.steps` を読む必要があります。
  `import_failures`(`{ file, message }`)は新しく加わったフィールドで、常に存在し、何も失敗しなければ `[]` です。
- **Allure はいまや scenario ごとではなく、step ごとに 1 つの test を書きます。**
  レポートの test 数は、いまや scenario 数ではなく step 数です。
  scenario 自身の成否は、単一の test からではなく `suite` の行から読んでください。
  Allure の history、trend、run をまたいだ flaky 検出はもう機能しません。
  CI で、run が生成したレポートの `history.jsonl` を次の run の `allure-results/` へ引き継ぐ運用を組んでいたなら、その引き継ぎはもう何もしません。
  この emitter の出力には、ある step を以前の run の自分自身に結び付けるものが何も無いからです。
- **`nuka steps` は、プロジェクトに features ディレクトリが無いとき、非ゼロで終了するようになりました。**
  nukadoko プロジェクトの外で叩いていたスクリプトや、`featuresDir` を改名したまま config を直していないスクリプトは、これまで空の語彙とクリーンな終了を受け取っていました。
  いまは探しに行った解決済みのパスが stderr に出て、終了コードは非ゼロになり、stdout には何も出ません。
  クリーンな終了に依存していたパイプラインがあれば、正しいディレクトリを指すか、`nukadoko.config.ts` の `featuresDir` を直してください。
  features ディレクトリが存在していて step が 0 本のプロジェクトは影響を受けず、これまでどおり `0` で終了します。

## 0.0.5 から 0.1.0 へ

破壊的変更は 3 つです。
各項目は「何を直すか」だけを述べます。
なぜそう変わったかは [CHANGELOG.md](../CHANGELOG.md) の `## 0.1.0` にあります。

- **型付き step の `run` は、`ctx` ではなく fixture bag を取るようになりました。**
  step が `ctx` から読んでいたものをすべて、分割代入された第一引数に集めてください(`run({ page, section }, args)`)。
  `page` / `request` の前にある `await` と、呼び出しの丸括弧を外してください。
  どちらも今は値であり、関数ではありません。
  このための codemod は同梱されていません。
- **`evidence.trace` は scenario record から、各 step 自身の record に移りました。**
  scenario record の `evidence.trace` を読んでいたものは、代わりにページを開いた step の step record を読む必要があります。
- **sign-off の記録のファイル名は、いまや条件を含みます。**
  旧来の `<feature-basename>.<date>-<sha>.md` を読んでいたものは、代わりに `<feature-basename>.<date>-<sha>.<environment>.<browser>.md` を読む必要があります。

## 0.0.5 より前

[CHANGELOG.md](../CHANGELOG.md) を参照してください。
