class IntegerReadsAs < Nukadoko::Step
  description "An integer the line gives is this number"
  pattern "the integer {given:int} reads as {expected:string}"
  args do
    number :given, "The value the line gives"
    string :expected, "The expected side"
  end
  claims [{ actual: "value", compare: "equal", expected: "expected", expected_view: "json" }]

  def observe(args:) = { value: args.given }
end
