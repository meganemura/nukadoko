class Equals < Nukadoko::Step
  description "The value read equals another"
  pattern "the value {actual:string} equals {other:string}"
  args do
    string :actual, "The value read, as text"
    string :other, "The expected side"
  end
  claims [{ actual: "value", view: "json", compare: "equal", expected: "other", expected_view: "json" }]

  def observe(args:) = { value: args.actual.gsub("\\n", "\n") }
end
