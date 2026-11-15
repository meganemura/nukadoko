class FloatReadsAs < Nukadoko::Step
  description "A float the line gives is this number"
  pattern "the float {given:float} reads as {expected:string}"
  args do
    number :given, "The value the line gives"
    string :expected, "The expected side"
  end
  claims [{ actual: "value", compare: "equal", expected: "expected", expected_view: "json" }]

  def observe(args:) = { value: args.given }
end
