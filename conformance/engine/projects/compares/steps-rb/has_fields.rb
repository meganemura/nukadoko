class HasFields < Nukadoko::Step
  description "The object read has the expected fields"
  pattern "the object {actual:string} has the fields {fields:string}"
  args do
    string :actual, "The value read, as text"
    string :fields, "The expected side"
  end
  claims [{ actual: "value", view: "json", compare: "has-fields", expected: "fields", expected_view: "json" }]

  def observe(args:) = { value: args.actual.gsub("\\n", "\n") }
end
