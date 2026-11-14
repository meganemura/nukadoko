# nukadoko の Ruby 版

[nukadoko](../README.ja.md) の Ruby のエンジンです。
Gherkin のステップに型付きの契約を付け、シナリオのまちがいを実行前に見つけます。
TypeScript 版と同じ feature ファイルを読み、同じ判定を返す必要があります。
[`../conformance/`](../conformance/README.md) のケースがそれを確かめます。

状態: 初期の核です。
`conformance/` の 10 のケースを通します。
HTTP のステップ、ブラウザのステップ、コマンドラインのステップ、プロジェクトが定義するフィクスチャ、parts でできたステップ、poll する Then ステップ、`from`、docstring、Scenario Outline、条件つきの環境、control と proof run、判定表です。
`--base`、`nuka do`、`nuka scaffold`、`nuka init` も動きます。
`nuka check` は、パターン、ステップの位置、タグ、Scenario Outline、`from` の順番、フィクスチャ、構文エラーについての指摘と、どこにも使われないステップ・フィクスチャ・`from` のキーや scaffold のままの説明についての注意を、TypeScript 版と同じく報告します。
`--concurrency` や Allure の出力など、TypeScript 版の機能の多くはまだありません。

## インストール

テストするプロジェクトの Gemfile に足します。
Ruby 3.4 以上が要ります。

```ruby
gem "nukadoko", group: :test
```

## ステップ

`features/steps/` の下に 1 ファイル 1 ステップで書きます。
ファイル名がステップ名です(`add_todo.rb` は `add-todo`)。

```ruby
class AddTodo < Nukadoko::Step
  pattern "a todo titled {title:string} is added"
  args { string :title, "The title of the todo to create" }
  returns do
    string :id
    string :title
    boolean :done
  end

  def run(request:, args:)
    request.post("/todos", data: { title: args.title }).json
  end
end
```

- nil を許すフィールドには `null: true` を付けます。`enum :outcome, %w[accepted refused]` はその語だけを許し、Steep はリテラルの和として扱います。
- パターンの取り出し部分にはすべて名前を付けます。名前は `args` のキーです。
- `run`(Then ステップでは `observe`)のキーワード引数が、ステップが使うフィクスチャです。`nuka check` は本体を呼ばずに `Method#parameters` で読みます。
- Then ステップは `claims` と、世界を読む `observe` を書きます。claim の判定は nukadoko が行います。claim が比べる args のキーは `observe` に渡されません。

## コマンド

- `nuka init` は、`nukadoko.config.rb`、空の `features/steps/`、`.nukadoko/` と `.env` のための `.gitignore` の行を書きます。
設定ファイルがすでにあれば断ります。
- `nuka check [--json]` は、実行前にまちがいを報告します。
- `nuka run [<feature[:line]|dir>...] [--tag <expression>]... [--env <name>]... [--order file|shuffled[:<seed>]] [--repeat <n>] [--proof-runs <n>] [--records] [--json] [--no-check]` は、選んだ world ごとにプログラムを起動し、選んだシナリオを実行して、ステップごとの記録を `.nukadoko/runs/` に書きます。
対象を書かなければ `features/` を実行します。
`--order shuffled` は、ファイルを、そしてファイルの中のシナリオを、seed が決める順番で実行します。
seed が同じなら、TypeScript 版と同じ順番です。
`--repeat` は選んだシナリオをその回数だけ実行し、`--proof-runs` は control を何回実行するかを決め、`--records` はシナリオの記録を終わるたびに stdout に書きます。
- `nuka verdict [--json]` は、いちばん新しい run が今の作業ツリーを判定し、赤を残さなかったかを答えます。
run は始めません。
- `nuka report [run] --format markdown [--out <file>] [--json]` は、run の `summary.md` を `run.json` だけからもう一度書きます。
run を名指ししなければ、いちばん新しい run を使います。
- `nuka clean [--dry-run] [--json]` は、`.nukadoko/` の下の run ディレクトリを消します。
- `nuka do <step> [--args <json>] [--use <step-id>]...` は、シナリオの外で 1 つのステップを実行し、ステップの記録を出します。
`--use` は、前の記録(`do` のものでも run のものでも)から、ステップの `from` の args を埋めます。
- `nuka scaffold <name> [--pattern <p>] [--then] [--description <text>] [--replace]` は、`features/steps/<name>.rb` を書きます。
本体は、だれかが書くまで `not implemented` で失敗します。
`nuka scaffold --feature <path>` は、どのステップにも合わない行ごとに 1 つ書き、パターンは行から読みます。
`--command`、`--request`、`--from` はまだありません。
- ブラウザの起動設定は `nukadoko.config.rb` に `Nukadoko.config(browser: { executablePath: "..." })` と書きます。`page` を使うステップは、シナリオごとに自分のブラウザコンテキストを持ちます。ステップの記録には、ページが送ったリクエストとステップのトレースが残ります。
- `scratch` を使うステップは `scratch.dir` で新しいディレクトリを得ます。シナリオが終わると消えます。`Nukadoko.run_command(command, args, cwd:)` はプログラムを実行し、`{ exitCode:, stdout:, stderr: }` を返します。ステップの記録には実行したプロセスが残ります。
- プロジェクトのフィクスチャは `nukadoko.config.rb` に書きます。ブロックは値を `use` に渡し、その後ろが後片付けです。例: `Nukadoko.fixture(:store) { |use| use.(Store.new) }`。`scope: :process` にすると、環境ごとの実行全体で 1 つの値を使います。
- `parts [CreateTodo, CompleteById]` で、ステップが呼べるステップを宣言します。`call.(CreateTodo, title: args.title)` で 1 つを実行し、args と返り値を確かめます。パターンのない part も書けます。呼び出しは、呼んだステップの記録の `calls` に残ります。`nuka check` は、`parts` の循環と、`mutates false` なのに `mutates true` の part を持つステップを報告します。
- `poll timeout_ms: 3000` は、すべての claim が 2 回続けて成り立つか時間切れになるまで、100 ミリ秒おきに `observe` を読み直します。`settled:` には、一度なったら変わらない状態を書きます。2 回続けてその状態なら、壊れた claim を待つのをやめます。読んだ結果はすべてステップの記録に残ります。
- `nuka steps [--json]` は語彙の一覧を出します。`nuka describe <step>` は 1 つのステップを、args と返り値の JSON Schema とともに出します。項目は TypeScript 版と同じです。
- 契約が宣言していない返り値のキーは、zod のオブジェクトと同じく捨てられます。ステップの記録の `returns_dropped` に、捨てたキーが残ります。
- `nuka sig` は `sig/nukadoko/steps.rbs` を書きます。Steep を使うと、宣言していない args のキーを読む本体や、形のちがう値を返す本体がエラーになります。

テストするプログラムは `nukadoko.program.rb` に書きます。

```ruby
Nukadoko.program serve: { command: "bin/rails server -p {port}", ready: "/up" }
```

## 開発

- このディレクトリで `bundle install` を実行します。
- `bundle exec ruby ../conformance/run-rb.rb` で、すべての検査ケースをこのエンジンで走らせます。
- `bundle exec bin/test` で単体テストと、`test/hegel/` の Hegel の性質テストを走らせます。gem には Ruby 3.4 以上が要ります。
