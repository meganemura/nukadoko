class ATodoIsAdded < Nukadoko::Step
  description "Add an open todo"
  pattern "a todo {title:string} is added"
  args do
    string :title, "The todo's title"
  end
  returns do
    string :state, "The todo's state"
  end
  # Keeps nothing.
  mutates false

  def run(args:) = { state: "open" }
end
