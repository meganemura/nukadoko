class ADoneTodo < Nukadoko::Step
  pattern "a done todo titled {title:string} exists"
  description "Create a todo and complete it, through two parts"
  args { string :title, "The title of the todo" }
  returns do
    string :id, "The id of the todo"
    boolean :done, "true once completed"
  end
  mutates true
  parts [CreateTodo, CompleteById]

  def run(call:, args:)
    created = call.(CreateTodo, title: args.title)
    completed = call.(CompleteById, id: created.id)
    { id: completed.id, done: completed.done }
  end
end
