class EveryScore < Nukadoko::Step
  description "Every row whose score is over 10 scores at least 5"
  pattern "every row of {given:string} with a score over 10 scores at least 5"
  args do
    string :given, "The value observe reads, as JSON"
  end
  claims [{ actual: "value.rows",
            each: { where: [{ actual: "score", compare: "greater-than", expected: { literal: 10 } }],
                    claims: [{ actual: "score", compare: "at-least", expected: { literal: 5 } }] } }]

  def observe(args:) = { value: JSON.parse(args.given) }
end
