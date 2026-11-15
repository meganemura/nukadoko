# nukadoko の Ruby 版

[nukadoko](../README.ja.md) の Ruby のエンジンです。
Gherkin のステップに型付きの契約を付け、シナリオのまちがいを実行前に見つけます。
TypeScript 版と同じ feature ファイルを読み、同じ判定を返す必要があります。
[`../conformance/`](../conformance/README.md) のケースがそれを確かめます。

状態: `conformance/engine/` のすべてのシナリオを通します。
これらのシナリオは、`nuka` の各コマンドを両方のエンジンに対して実行します。
`conformance/` の 10 のケースも通します。
HTTP のステップ、ブラウザのステップ、コマンドラインのステップ、プロジェクトが定義するフィクスチャ、parts でできたステップ、poll する Then ステップ、`from`、docstring、Scenario Outline、条件つきの環境、control と proof run、判定表です。
`--base`、`--step`、`nuka do`、`nuka scaffold`、`nuka init` も動きます。
`nuka check` は、パターン、ステップの位置、タグ、Scenario Outline、`from` の順番、フィクスチャ、構文エラーについての指摘と、どこにも使われないステップ・フィクスチャ・`from` のキーや scaffold のままの説明についての注意を、TypeScript 版と同じく報告します。
`nuka init --allure` など、TypeScript 版の機能の一部はまだありません。

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
Rakefile に `scenarios` タスクがなければ、`bundle exec nuka run` を実行するタスクを足すので、人も CI も `rake scenarios` を実行します。
設定ファイルがすでにあれば断ります。
- `nuka check [--json]` は、実行前にまちがいを報告します。
- `nuka run [<feature[:line]|dir>...] [--tag <expression>]... [--env <name>]... [--order file|shuffled[:<seed>]] [--repeat <n>] [--concurrency <n>] [--proof-runs <n>] [--step] [--records] [--json] [--no-check]` は、選んだ world ごとにプログラムを起動し、選んだシナリオを実行して、ステップごとの記録を `.nukadoko/runs/` に書きます。
対象を書かなければ `features/` を実行します。
`--order shuffled` は、ファイルを、そしてファイルの中のシナリオを、seed が決める順番で実行します。
seed が同じなら、TypeScript 版と同じ順番です。
`--concurrency` は、feature ファイルを丸ごと、その数の worker プロセスに分けて実行します。
Feature の行に `@nukadoko:serial` があるファイルは、ほかのファイルのあとに 1 つずつ実行します。
`--repeat` は選んだシナリオをその回数だけ実行し、`--proof-runs` は control を何回実行するかを決め、`--records` はシナリオの記録を終わるたびに stdout に書きます。
- `nuka verdict [--json]` は、いちばん新しい run が今の作業ツリーを判定し、赤を残さなかったかを答えます。
run は始めません。
- `nuka judge <feature>:<line> [--run <id>] [--json]` は、Then が判断を求める基準(`judged-as` の claim)について、run が読んだ値を見せます。
`--meets` か `--misses` に `--by <who>` と `--because <一文>` を付けると、その値の判断を `judgments/<feature>.json` に記録します。
次の run は、この記録と照らして基準を読みます。
- `nuka report [run] --format markdown|messages|allure [--out <path>] [--json]` は、run を run ディレクトリだけからもう一度書きます。
run を名指ししなければ、いちばん新しい run を使います。
`markdown` は run の `summary.md` です。
`messages` は cucumber-messages の stream で、1 行に 1 つの envelope を書きます。
cucumber のプロトコルを読む formatter や JUnit のステップは、そのまま動きます。
claim のステップの claims と、各基準の判定は attachment として載ります。
`allure` は Allure の結果のディレクトリで、`--out` で別の場所を指定しなければ `.nukadoko/export/allure-results` に書きます。
1 回の実行が 1 つの結果になり、各 claim はその Then の子ステップになります。
history id は、同じシナリオについて TypeScript 版が書く結果と同じです。
- `nuka run <feature>:<line> --step` は、1 つのシナリオを 1 ステップずつ進めます。
各ステップのあと、`nuka step` が答えるまで待ちます。
`nuka step wait [--walk <n>] [--timeout <s>] [--json]` は、walk がいまどこにいるかを出します。
止まったステップ、その記録、開いたままのページのスクリーンショットと ARIA スナップショットです。
`nuka step next <pause> --walk <n>` は次のステップを実行し、`nuka step stop <pause> --walk <n>` は残りを飛ばします。
止めたシナリオは stopped になり、その行は赤になります。
どちらのエンジンの `nuka step` も、どちらのエンジンの walk に答えられます。
- `nuka clean [--dry-run] [--json]` は、`.nukadoko/` の下の run ディレクトリを消します。
- `nuka skill path` は、gem に入っているエージェント向けスキル(`nukadoko` と `nukadoko-verification`)のディレクトリを出します。
npm パッケージに入っているものと同じスキルです。
- `nuka do <step> [--args <json>] [--use <step-id>]...` は、シナリオの外で 1 つのステップを実行し、ステップの記録を出します。
`--use` は、前の記録(`do` のものでも run のものでも)から、ステップの `from` の args を埋めます。
- `nuka scaffold <name> [--pattern <p>] [--then] [--description <text>] [--replace]` は、`features/steps/<name>.rb` を書きます。
本体は、だれかが書くまで `not implemented` で失敗します。
`nuka scaffold --feature <path>` は、どのステップにも合わない行ごとに 1 つ書き、パターンは行から読みます。
`--command <entry point>` は、プログラムを Ruby で scratch ディレクトリの中で実行し、`exitCode`、`stdout`、`stderr` を返すステップを書きます。
`--cwd <key>` は args のキーが持つディレクトリで実行し、`--argv <key>` は 1 つのキャプチャを空白で分けて引数にします。
gem が入れる実行ファイルには、`bundle binstubs <gem>` が `bin/<name>` を書くので、それを `--command` に渡せます。
`--request "<METHOD> <path>"` は、リクエストを 1 つ送り、`status` と `body` を返すステップを書きます(`--body <key>` はその args のキーを送ります)。
`--from <step>.<key>` は、前のステップの returns から args のキーを埋めます。
`--then` とキャプチャ 1 つと一緒に使うと、claim がその 2 つを比べるので、ステップは書き直さずに使えます。
- ブラウザの起動設定は `nukadoko.config.rb` に `Nukadoko.config(browser: { executablePath: "..." })` と書きます。`page` を使うステップは、シナリオごとに自分のブラウザコンテキストを持ちます。ステップの記録には、ページが送ったリクエストとステップのトレースが残ります。
- `scratch` を使うステップは `scratch.dir` で新しいディレクトリを得ます。シナリオが終わると消えます。`scratch.copy(source)` は、プロジェクトのファイルかディレクトリの写しを入れた新しいディレクトリを返します。`args:` キーワードを書かない本体は、args なしで呼ばれます。`Nukadoko.run_command(command, args, cwd:, env:, input:, timeout:, redact:)` はプログラムを実行し、`{ exitCode:, signal:, stdout:, stderr: }` を返します。ステップの記録には実行したプロセスが残り、`redact:` に渡した値は `{{secret.NAME}}` になります。
- `Nukadoko.config(envFiles: [".env"])` は env ファイルを `env` フィクスチャに読み込みます。`nukadoko.program.rb` の環境は、その後ろに自分の `envFiles:` を足せます。git が追跡していないファイルと HEAD と違うファイルは秘密の出どころです。その 4 文字以上の値は、ステップの記録、`http.jsonl`、`nuka do` の出力で `{{secret.NAME}}` に置き換わります。`secrets: { public: [...], redact: [...] }` で、そのようなキーを平文のままにしたり、追跡しているファイルのキーを伏せたりできます。`nuka check` は、無いファイル、読み飛ばした行、どのファイルにもない `secrets` のキーを警告し、値は表示しません。
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
- `bundle exec rbs-inline --output=sig/generated lib` で、`lib/` の `#:` と `# @rbs` のコメントから型の定義を書き出します。
  `bundle exec steep check` で、`lib/` をその定義で検査します。
  rbs-inline が書き出したものはコミットします。
  `sig/nukadoko.rbs` には rbs-inline が書けないものを、`sig-deps/` には型の定義を持たない gem の、使っている部分を書きます。
