class NameField < Nukadoko::Step
  description "The name of the user the value holds"
  pattern "the name-field of {given:string} is {expected:string}"
  args do
    string :given, "The value observe reads, as JSON"
    string :expected, "The expected side"
  end
  claims [{ actual: "value.user.name", compare: "equal", expected: "expected" }]

  def observe(args:) = { value: JSON.parse(args.given) }
end
