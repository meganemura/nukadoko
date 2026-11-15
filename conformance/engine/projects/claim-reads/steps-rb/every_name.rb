class EveryName < Nukadoko::Step
  description "The name of the user each row holds"
  pattern "every row of {given:string} names {expected:string}"
  args do
    string :given, "The value observe reads, as JSON"
    string :expected, "The expected side"
  end
  claims [{ actual: "value.rows", each: { claims: [{ actual: "user.name", compare: "equal", expected: "expected" }] } }]

  def observe(args:) = { value: JSON.parse(args.given) }
end
