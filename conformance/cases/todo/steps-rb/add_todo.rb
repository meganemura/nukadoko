class AddTodo < Nukadoko::Step
  pattern "a todo titled {title:string} is added"
  description "Create a todo via POST /todos and return the created record"
  args { string :title, "The title of the todo to create" }
  returns do
    string :id, "The id the server assigned"
    string :title, "The title as the server stored it"
    boolean :done, "Whether the todo is done; false for a new one"
  end
  mutates true

  def run(request:, args:)
    request.post("/todos", data: { title: args.title }).json
  end
end
