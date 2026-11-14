class SignInIsRefused < Nukadoko::Step
  description "The last sign-in attempt was refused with exactly this reason"
  pattern "the sign-in is refused because {expected:string}"
  args do
    string :expected, "The expected reason"
    field :outcome, SignIn.returns[:outcome]
    field :reason, SignIn.returns[:reason]
  end
  from outcome: [SignIn, :outcome], reason: [SignIn, :reason]
  claims [
    { actual: "outcome", compare: "equal", expected: { literal: "refused" } },
    { actual: "reason", compare: "equal", expected: "expected" }
  ]
end
