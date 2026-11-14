class LacksField < Nukadoko::Step
  description "The object read has no field of this name"
  pattern "the object {actual:string} lacks the field {field:string}"
  args do
    string :actual, "The value read, as text"
    string :field, "The expected side"
  end
  claims [{ actual: "value", view: "json", compare: "lacks-field", expected: "field" }]

  def observe(args:) = { value: args.actual.gsub("\\n", "\n") }
end
