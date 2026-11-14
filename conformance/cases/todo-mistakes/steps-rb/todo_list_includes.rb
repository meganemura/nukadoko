class TodoListIncludes < Nukadoko::Step
  pattern "the todo list includes {title:string}"
  description "A todo with this title is present in GET /todos"
  args { string :title, "The title expected to be present" }
  claims [{ actual: "titles", compare: "includes-item", expected: "title" }]

  def observe(request:, args:)
    { titles: request.get("/todos").json.map { _1["title"] } }
  end
end
