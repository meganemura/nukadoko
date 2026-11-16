class ListOfTodos < Nukadoko::Step
  description "A list of todos, the last one done"
  pattern "a list of {count:int} todos"
  args do
    integer :count, "How many todos", positive: true
  end
  returns do
    array :todos, "The todos" do
      string :id, "The todo's id"
      boolean :done, "Whether it is done"
    end
  end
  # Keeps nothing.
  mutates false

  def run(args:) = { todos: Array.new(args.count) { |i| { id: "t#{i + 1}", done: i == args.count - 1 } } }
end
