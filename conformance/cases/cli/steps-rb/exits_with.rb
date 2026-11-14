class ExitsWith < Nukadoko::Step
  description "The process exit code is exactly this"
  pattern "it exits with {code:int}"
  args do
    number :code, "The expected exit code"
    field :exitCode, RunTally.returns[:exitCode]
  end
  from exitCode: [RunTally, :exitCode]
  claims [{ actual: "exitCode", compare: "equal", expected: "code" }]
end
