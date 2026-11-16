class ATodoIsAddedDone < Nukadoko::Step
  description "Add a todo that is already done"
  pattern "a todo {title:string} is added done"
  args do
    string :title, "The todo's title"
  end
  returns do
    string :state, "The todo's state"
  end
  # Keeps nothing.
  mutates false

  def run(args:) = { state: "done" }
end
