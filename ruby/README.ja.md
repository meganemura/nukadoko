# nukadoko の Ruby 版

[nukadoko](../README.ja.md) の Ruby のエンジンです。
Gherkin のステップに型付きの契約を付け、シナリオのまちがいを実行前に見つけます。
TypeScript 版と同じ feature ファイルを読み、同じ判定を返す必要があります。
[`../conformance/`](../conformance/README.md) のケースがそれを確かめます。

状態: 初期の核です。
todo の例を check して実行できます。
TypeScript 版の機能の多くはまだありません。

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

- パターンの取り出し部分にはすべて名前を付けます。名前は `args` のキーです。
- `run`(Then ステップでは `observe`)のキーワード引数が、ステップが使うフィクスチャです。`nuka check` は本体を呼ばずに `Method#parameters` で読みます。
- Then ステップは `claims` と、世界を読む `observe` を書きます。claim の判定は nukadoko が行います。claim が比べる args のキーは `observe` に渡されません。

## コマンド

- `nuka check [--json]` は、実行前にまちがいを報告します。
- `nuka run [--json] [--no-check]` は、プログラムを起動してすべてのシナリオを実行し、ステップごとの記録を `.nukadoko/runs/` に書きます。
- `nuka sig` は `sig/nukadoko/steps.rbs` を書きます。Steep を使うと、宣言していない args のキーを読む本体や、形のちがう値を返す本体がエラーになります。

テストするプログラムは `nukadoko.program.rb` に書きます。

```ruby
Nukadoko.program serve: { command: "bin/rails server -p {port}", ready: "/up" }
```

## 開発

- このディレクトリで `bundle install` を実行します。
- `ruby ../conformance/run-rb.rb` で、すべての検査ケースをこのエンジンで走らせます。
