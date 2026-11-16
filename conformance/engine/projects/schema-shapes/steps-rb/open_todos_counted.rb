class OpenTodosCounted < Nukadoko::Step
  description "Count the open todos, up to a limit"
  pattern "the open todos are counted"
  args do
    field :todos, ListOfTodos.returns[:todos]
    string :owner, "The owner, when a line names one", optional: true
    integer :limit, "The most todos counted", default: 10
  end
  from todos: [ListOfTodos, :todos], owner: [AnOwner, :name]
  returns do
    integer :count, "How many todos are open", min: 0
    string :owner, "The owner, or nobody"
  end
  # Keeps nothing.
  mutates false

  def run(args:) = { count: [args.limit, args.todos.count { !_1["done"] }].min, owner: args.owner || "nobody" }
end
