class RegistrationIsRefused < Nukadoko::Step
  description "The last registration was refused with exactly this reason"
  pattern "the registration is refused because {expected:string}"
  args do
    string :expected, "The expected reason"
    field :outcome, Register.returns[:outcome]
    field :reason, Register.returns[:reason]
  end
  from outcome: [Register, :outcome], reason: [Register, :reason]
  claims [
    { actual: "outcome", compare: "equal", expected: { literal: "refused" } },
    { actual: "reason", compare: "equal", expected: "expected" }
  ]
end
