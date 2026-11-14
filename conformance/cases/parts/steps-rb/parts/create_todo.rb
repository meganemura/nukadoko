class CreateTodo < Nukadoko::Step
  description "Create a todo via POST /todos; a part with no pattern of its own"
  args { string :title, "The title of the todo to create" }
  returns do
    string :id, "The id the server assigned"
    string :title, "The title as the server stored it"
    boolean :done, "Whether the todo is done"
  end
  mutates true

  def run(request:, args:) = request.post("/todos", data: { title: args.title }).json
end
