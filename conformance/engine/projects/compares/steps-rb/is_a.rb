class IsA < Nukadoko::Step
  description "The value read is of this kind"
  pattern "the value {actual:string} is a {kind:string}"
  args do
    string :actual, "The value read, as text"
    string :kind, "The expected side"
  end
  claims [{ actual: "value", view: "json", compare: "is-a", expected: "kind" }]

  def observe(args:) = { value: args.actual.gsub("\\n", "\n") }
end
