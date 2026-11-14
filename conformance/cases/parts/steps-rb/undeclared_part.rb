class UndeclaredPart < Nukadoko::Step
  pattern "a todo titled {title:string} is added without declaring its part"
  description "Calls a part that parts does not declare, which call refuses"
  args { string :title, "The title of the todo" }
  mutates true
  parts []

  def run(call:, args:)
    call.(CreateTodo, title: args.title)
    {}
  end
end
