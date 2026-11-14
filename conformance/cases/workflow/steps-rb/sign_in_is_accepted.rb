class SignInIsAccepted < Nukadoko::Step
  description "The last sign-in attempt was accepted"
  pattern "the sign-in is accepted"
  args { field :outcome, SignIn.returns[:outcome] }
  from outcome: [SignIn, :outcome]
  # "accepted" is a word of the pattern, so the sentence states the value.
  claims [{ actual: "outcome", compare: "equal", expected: { literal: "accepted" } }]
end
