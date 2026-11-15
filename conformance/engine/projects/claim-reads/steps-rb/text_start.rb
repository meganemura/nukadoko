class TextStart < Nukadoko::Step
  description "The text the value starts with"
  pattern "the text-start of {given:string} is {expected:string}"
  args do
    string :given, "The value observe reads, as JSON"
    string :expected, "The expected side"
  end
  claims [{ actual: "value", view: "text", compare: "starts-with-text", expected: "expected" }]

  def observe(args:) = { value: JSON.parse(args.given) }
end
