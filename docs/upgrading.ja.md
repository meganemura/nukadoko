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
  discovery が読めたものはそのまま返り、読めなかったものは stderr と `import_failures` に名指しされます(`nuka steps --json` のトップレベルは素の配列ではなく `{ steps, import_failures }` です)。
- **`needs_inferred` は、まだ誰も手を付けていない step からでも引けます。**
  `run()` が分割代入されていない第一引数を取ったままの step には、その引数自身のメンバアクセスから読み取ったベストエフォートの `needs_inferred` が付きます。
  アップグレードの途中で、fixture の棚卸しを手作業で組み立てる必要はありません。
- **`nuka check` の findings はまとめられ、繰り返されません。**
  複数のファイルに当てはまる finding(たとえば `step-file-import-failed`)は、メッセージを 1 回だけ出し、その後にソートされたファイル一覧を続けます。
  ファイルごとに繰り返しはしません。
- **順番**: パッケージを上げる → `nuka check` を実行する → 指摘を直す → `nuka run` を実行する → 両方 green になるまで繰り返す。

## 0.14.1 から次のリリースへ

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
run サマリの横で pull request を承認することは同じ主張(「このコミットで green」)をし、forge がそれをコミットに結び付けます。
すべての `nuka run` がそのサマリを書くようになりました。
pull request に投稿する方法は [docs/ci.ja.md](ci.ja.md) にあります。
やることは次のとおりです。

- **スクリプトと CI から `nuka accept` を取り除きます。**
  コマンドはもう存在しないので、`nuka accept <feature>` は yargs の unknown argument のエラーで 1 を返して終わります。
  green の `nuka run` の後でジョブがそれを実行していたところでは、代わりに run サマリを投稿します。
  `nuka run <features> --summary <path>` を実行し、そのファイルを pull request にコメントする step を続けます([docs/ci.ja.md](ci.ja.md) の workflow にあります)。
- **feature に sign-off の記録があるかを見る PR の検査を置き換えます。**
  変更された各 feature の隣に `<feature>.*.md` のファイルを探すジョブや、`nuka tend --fail-on feature-never-signed` を実行するジョブには、もう確かめるものがありません。
  レビュアーは差分の中の `.feature` と pull request 上の run サマリを読み、pull request の承認が sign-off になります。
  削除された code(`feature-never-signed`、`signed-feature-unscanned`、`signoff-condition-mismatch`、`signoff-feature-changed`、`signoff-feature-missing`、`signoff-record-old-format`、`signoff-record-unreadable`、`signoff-result-invalid`、`signoff-step-missing`)のどれかを付けた `nuka tend --fail-on` は、何も解析する前に 1 で終わります。
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
- **Allure と messages の emitter は、config にそのキーがあるまで無効です。**
  以前の `nuka run` は、設定なしで `.nukadoko/export/allure-results/` と `.nukadoko/export/messages.ndjson` を書いていました。
  Allure の result を読むプロジェクトは、`nukadoko.config.ts` に `allure: {}` を追加します。
  cucumber messages を formatter や JUnit ベースの CI に渡すプロジェクトは、`messages: {}` を追加します。
  すでに `allure.resultsDir` や `messages.output` を設定しているプロジェクトは、キーがすでにあるので何も変える必要はありません。
  どちらも読まないプロジェクトは、`allurerc.mjs` と export ディレクトリを消して構いません。
  以前の run が書いたものは、今までどおり `nuka clean --export` で消せます。
- **`nuka init` が書くものは減り、つなぐものは増えました。**
  `--allure` や `--env` で求めない限り、`allurerc.mjs`、result のディレクトリ、`.gitignore` の `.env` の行を書かなくなりました。
  また、`package.json` に `test:scenarios` script を追加します。
  変わるのは新しく `init` したときに書かれるものだけで、すでに初期化したプロジェクトは何もする必要がありません。

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
