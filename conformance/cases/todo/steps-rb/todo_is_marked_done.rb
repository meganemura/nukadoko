class TodoIsMarkedDone < Nukadoko::Step
  pattern "the todo titled {title:string} is marked {state:word}"
  description "The todo with this title has the state the line names in GET /todos"
  args do
    string :title, "The title of the todo to read"
    string :state, 'The state the todo is expected to have: "done" or "open"'
  end
  claims [{
    actual: "todos",
    each: {
      where: [{ actual: "title", compare: "equal", expected: "title" }],
      claims: [{ actual: "state", compare: "equal", expected: "state" }]
    }
  }]

  def observe(request:, args:)
    { todos: request.get("/todos").json.map { { title: _1["title"].to_s, state: _1["done"] == true ? "done" : "open" } } }
  end
end
