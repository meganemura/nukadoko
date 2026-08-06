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

## Unreleased

破壊的変更は 1 つです。
その項目は「何を直すか」だけを述べます。
なぜそう変わったかは [CHANGELOG.md](../CHANGELOG.md) の `## Unreleased` にあります。

- **`nuka steps --json` のトップレベルは、素の配列から `{ steps, import_failures }` に変わりました。**
  旧来の素の配列を読んでいたものは、いまや `.steps` を読む必要があります。
  `import_failures`(`{ file, message }`)は新しく加わったフィールドで、常に存在し、何も失敗しなければ `[]` です。

## 0.0.5 から 0.1.0 へ

破壊的変更は 3 つです。
各項目は「何を直すか」だけを述べます。
なぜそう変わったかは [CHANGELOG.md](../CHANGELOG.md) の `## 0.1.0` にあります。

- **型付き step の `run` は、`ctx` ではなく fixture bag を取るようになりました。**
  step が `ctx` から読んでいたものをすべて、分割代入された第一引数に集めてください(`run({ page, section }, args)`)。
  `page` / `request` の前にある `await` と、呼び出しの丸括弧を外してください。
  どちらも今は値であり、関数ではありません。
  このための codemod は同梱されていません。
- **`evidence.trace` は scenario record から、各 step 自身の receipt に移りました。**
  scenario record の `evidence.trace` を読んでいたものは、代わりにページを開いた step の receipt を読む必要があります。
- **sign-off の記録のファイル名は、いまや条件を含みます。**
  旧来の `<feature-basename>.<date>-<sha>.md` を読んでいたものは、代わりに `<feature-basename>.<date>-<sha>.<environment>.<browser>.md` を読む必要があります。

## 0.0.5 より前

[CHANGELOG.md](../CHANGELOG.md) を参照してください。
