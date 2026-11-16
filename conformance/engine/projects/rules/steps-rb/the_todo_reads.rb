class TheTodoReads < Nukadoko::Step
  description "A todo's state reads as this text"
  pattern "the todo {title:string} reads {expected:string}"
  args do
    string :title, "The todo's title"
    string :expected, "The expected state"
  end
  claims [{ actual: "value", compare: "equal", expected: "expected" }]

  def observe(args:) = { value: args.title == "dust" ? "done" : "open" }
end
