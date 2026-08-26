# nukadoko のアップグレード

> 原文は upgrading.md。相違があれば原文が正。

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

## 0.7.0 から次のリリースへ

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
  各呼び出しはいま、設定されたパスの隣にある自分自身のファイル(設定されたパス自身の名前に run id を差し込んだもの。既定のパスなら `messages.<run_id>.ndjson`)に書き込み、run が終わった時点で初めて、原子的に設定されたパスを置き換えます。
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
