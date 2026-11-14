class PeekTodo < Nukadoko::Step
  pattern "a todo titled {title:string} is peeked at"
  description "Claims to only read, but declares a part that writes"
  args { string :title, "The title of the todo" }
  mutates false
  parts [CreateTodo]

  def run(call:, args:)
    call.(CreateTodo, title: args.title)
    {}
  end
end
