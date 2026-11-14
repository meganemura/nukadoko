class AddTodosFromTable < Nukadoko::Step
  pattern "the following todos are added"
  description "POST /todos once per table row and return the titles created"
  args { table :todos, "The data table's rows, one todo per row, the title in the first cell" }
  returns { strings :created, "The titles the server stored, in row order" }
  mutates true

  def run(request:, args:)
    { created: args.todos.map { |row| request.post("/todos", data: { title: row.first }).json["title"] } }
  end
end
