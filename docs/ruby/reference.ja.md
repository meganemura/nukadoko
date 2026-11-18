# Ruby エンジン

> 原文は reference.md。

`nukadoko` gem で step、fixture、config をどう書くかをまとめます。
feature ファイル、claim、run、record の意味はどちらのエンジンでも同じで、[spec](../spec.ja.md) に一度だけ書いてあります。
[TypeScript エンジンのページ](../typescript/reference.ja.md) は同じ見出しを同じ順に並べているので、2 つを並べて読めます。

## インストールとコマンド

Ruby 3.4 以降が要ります。
テスト対象のプロジェクトの Gemfile に gem を足し、`bundle exec nuka` で実行します。

```ruby
gem "nukadoko", group: :test
```

```sh
bundle install
bundle exec nuka init
```

プロジェクトに `Rakefile` があれば、`init` はそこに `bundle exec nuka run` を実行する `scenarios` タスクを足します。
人も CI も、この 1 つのコマンドを実行します。

`page` を使う step には、`playwright-ruby-client` が起動できるブラウザが要ります。

## 設定

`nuka init` は `nukadoko.config.rb` を書きます。
このファイルは `Nukadoko.config(...)` をキーワード引数で呼び、オプションの名前は TypeScript の config と同じです。
`program` とプロジェクトの fixture はこのページの下にあります。
`envFiles:` と `secrets:` は `env` fixture のため、`browser:` はブラウザの起動オプション、`stepTimeout:` は step が動いてよい時間(ミリ秒、既定は 20 分)、`parameterTypes:` は文の途中で値を読む parameter type のためのものです。

```ruby
Nukadoko.config(parameterTypes: [{ name: "priority", regexp: /高|低/, transformer: ->(s) { s == "高" ? "high" : "low" } }])
```

## step を定義する

`features/steps/` の下に、1 ファイルに 1 つの step を snake_case の名前で置きます。
step の名前は、ファイル名の `_` を `-` にしたものです(`an_item_exists.rb` は `an-item-exists`)。
ファイルは、名前を CamelCase にしたクラスを `Nukadoko::Step` を継承して定義します。

```ruby
class AnItemExists < Nukadoko::Step
  description "Create an item through the API so a later step can read it"
  pattern "an item named {name:string} exists"
  args { string :name, "The item's name" }
  returns do
    number :id, "The id the API assigned"
    object :body, "The item as the API answered it" do
      number :id
      string :name
    end
  end

  def run(baseURL:, args:)
    res = Net::HTTP.post(URI("#{baseURL}/items"), JSON.generate(name: args.name))
    raise %(creating "#{args.name}": status #{res.code.to_i}, not 201) unless res.code.to_i == 201

    item = JSON.parse(res.body)
    { id: item["id"], body: item }
  end
end
```

`mutates false` は、何も変えない step であることを宣言します。
`patterns` は `pattern` のあとに同じ step の別の言い方を足します。
どの言い方も同じキーをキャプチャしなければなりません(そうでなければ `alias-key-mismatch`)。
`timeout 5000` は step 自身の `run` か `observe` の時間をミリ秒で区切ります。
過ぎると step は `error.kind` が `timeout` で失敗し、指定がなければ config の `stepTimeout` が効きます。

```ruby
class ItemCount < Nukadoko::Step
  description "Count the items the API lists"
  pattern "I count the items"
  patterns "the items are counted"
  timeout 5000
  # ...
end
```

`requires` は行の前に成り立っている必要がある state、`gives` は行のあとに成り立つ state、`ends` は行のあとに成り立たなくなる state を名指します。
エントリは名前か、名前と、持ち主を区別する値を持つ args のキーの組です(`requires ["signed-in", :person]`)。
`nuka check` は各 scenario をこれに沿ってたどり、state なしでしか着けない行に `state-missing` を報告します。
`nuka run` はその scenario を、どの step も動かす前に断ります。
何を宣言するかは spec の「States」に書いてあります。

`features/steps/` の下の `*.rb` は、`features/steps/lib/` の下の補助ファイルも含めてすべて読み込みます。
そのため、ファイル名どおりの名前の補助モジュールは、`require` なしでどの step からも使えます。

## フィールドとスキーマ

`args` と `returns` は、フィールドを並べたブロックを受け取ります。
フィールドは `string`、`number`、`integer`、`boolean`、`object`、`array`、`unknown`、`table` と、リストの `strings`、`numbers`、`integers` です。
nil を許すフィールドには `null: true`、キーがなくてもよいフィールドには `optional: true`、キーがないときに読む値には `default:` を付けます。
`enum :outcome, %w[accepted refused]` は、その語だけを許します。
`min:`、`max:`、`positive: true`、`negative: true` は、数の値、文字列の長さ、配列の要素数を、zod と同じメッセージで制限します。
`nuka describe` は、各スキーマを TypeScript エンジンと同じ JSON Schema で出します。

## キャプチャ、テーブル、doc string

pattern の `{key:type}` は、args のキー `key` を埋めます。
データテーブルは `table` のキーに、doc string は `string` として、そのキーに届きます。

```ruby
args { table :todos, "The data table's rows, one todo per row, the title in the first cell" }
```

## Claims

Then の step は、`run` の代わりに `claims` と、世界を読む `observe` を宣言します。
各 claim は nukadoko が判定します([spec](../spec.ja.md#claims) の「Claims」)。
claim が比べる args のキーは、`observe` には渡りません。

`files written: { of: RunBuild, change: "added", under: "src" }` は、前の step のコマンドが加えた、変えた、消したパスを名指しします。
claim はそのキーを実際の値として読みます([spec](../spec.ja.md) の「前の step が変えたファイル」)。
一覧はその step の record から、その step が走らせた各 `Nukadoko.run_command` から作られ、`run` が返したものからは作られません。

## 連鎖(`from`)

`from id: [StartJob, :id]` は、`StartJob` という step がこの scenario で先に返した値で `id` を埋めます。
`field :id, StartJob.returns[:id]` で、返す側のフィールドをそのキーに使い回せます。

## Parts

`parts [CreateTodo, CompleteById]` は `run` が呼んでよい step を並べ、`call.(CreateTodo, title: args.title)` はその 1 つを args と returns を検査しながら実行します([spec](../spec.ja.md#parts) の「Parts」)。

```ruby
parts [CreateTodo, CompleteById]

def run(call:, args:)
  created = call.(CreateTodo, title: args.title)
  completed = call.(CompleteById, id: created.id)
  { id: completed.id, done: completed.done }
end
```

## Fixtures

config の `Nukadoko.fixture` で、プロジェクトの fixture を足します。
ブロックが値を渡して `use` を呼び、そのあとが後片付けです。
必要な fixture はキーワード引数で挙げ、組み込みと同じ名前の fixture は、すべての step でその組み込みに置き換わります。
`scope: :process` は、1 つの environment の run 全体で 1 つの値を使い続けます。

```ruby
Nukadoko.fixture(:page) do |use, page:|
  page.add_init_script(script: "window.wrapped = 'by the project'")
  use.(page)
end
```

## Context

`run` と `observe` のキーワード引数が、step の必要とする fixture です。
名前は `page`、`context`、`page_as`、`request`、`env`、`require_env`、`base_url`、`scratch`、`section`、`poll`、`evidence`、`result_of`、`call` です。
`baseURL`、`requireEnv`、`pageAs`、`resultOf` と TypeScript の名前で書いても、同じ fixture に届きます。
`nuka check` は本体を呼ばずに `Method#parameters` でこれを読みます([spec](../spec.ja.md#context-api) の「Context API」)。
`scratch.dir` は新しいディレクトリで、scenario が終わると消えます。
`Nukadoko.run_command` はプログラムを実行し、それを step record に残します。

## ポーリングと待ち

Then の step の `poll timeout_ms: 3000, settled: [...]` は、続けて 2 回読んだ値ですべての claim が成り立つか、時間が切れるまで、`observe` を読み直します。

## プログラム

テスト対象のプログラムは config の `program:` で、プログラムの起動のしかたを返す lambda です。

```ruby
Nukadoko.config(
  program: -> { { serve: { command: "bin/rails server -p {port}", ready: "/up" } } },
)
```

フィールドは [spec](../spec.ja.md#テスト対象のプログラム) の「テスト対象のプログラム」にあります。
`serve` は `command`、`port`(既定の `"auto"` か、まだ何も応答しない番号)、`ready`(既定は `/`)、`timeout_ms`(既定は 60000)を取ります。
`ready` が `timeout_ms` のうちに 2xx を返した時点で、world の準備ができたとみなします。
コマンドは単語の Array か、空白で分ける String です。
どちらもシェルを通さないので、シェルが要るプログラムは `["sh", "-c", "..."]` と書きます。
プログラムが知らないキーは止めます。
TypeScript エンジンが読んでこのエンジンがまだ読まないキー(下)も止めます。
プログラムが起動しなかった world ではシナリオを 1 つも走らせず、実行は `program-start-failed` と world の `program.log` の終わりを示して失敗します。

world は TypeScript エンジンと同じ順に段階を進みます。
`build`(実行ごとに tree ごと 1 回、どの world よりも前に走るコマンド)、`prepare`(world ごと 1 回、その env とプレースホルダで走るコマンド)、次に `serve` か `url`(nukadoko が起動しないプログラムの URL か、それを返す lambda)、最後に `setup`(world を受け取る lambda で、`name`、`root`、`dir`、`tree`、`url`、`port`、`env` を持つ)です。
コマンドは `{ command:, timeout_ms: }` とも書けます。
`setup` と `url` の lambda も、`timeout_ms` 付きの `{ run: }` と `{ resolve: }` で書けます。
失敗した段階や制限時間を過ぎた段階は world を止め、その段階の名前を示します。
environment は `policy: "read-only"` を取り、mutates を宣言する step をすべて失敗にします。
`version:` は String を返す lambda で、その値は run.json とすべての記録に `target_version` として入ります。
world に値がないプレースホルダ(`serve` も `url` もない world の `{port}`、`build` の `{root}` 以外)は、`nuka check` で `program-placeholder-unfilled` になります。

nukadoko が起動する world のプログラムが `{events}` を名指すと、run ディレクトリの外に空のファイルができ、プログラムはそこに実行イベントを書き足します。
各 step の行は record の隣に残り、`observed.events` にまとめられます。
world が止まると、redact した world 全体の写しが `program.log` の隣に入ります([spec](../spec.ja.md) の「実行イベント」)。

## 型とツール

`nuka sig` は、各 step の args と returns の RBS を `sig/nukadoko/steps.rbs` に書きます。
Steep を使うと、宣言していない args のキーを読む本体や、違う形を返す本体がエラーになります。

## このエンジンにないもの

TypeScript エンジンにあって、このエンジンにまだないものです。
spec では、その例に `<!-- engine: typescript -->` を付けています。

- プログラムの `lists`。
- step の `events`(実行イベントの数についての claim)と、step のイベントのうちの flag とリクエストの並びである `path`。
- fixture の `use` が返すもの。
TypeScript エンジンは scenario の結果を返すので、後片付けで失敗の跡を残せます。
- MCP クライアントの呼び出しを記録する `measureMcp`。
- 既存のスイートを取り込む 2 つの扉、cucumber-js からと Playwright Test から。
どちらも JavaScript のスイートなので、TypeScript エンジンのものです([doors.ja.md](../typescript/doors.ja.md))。
