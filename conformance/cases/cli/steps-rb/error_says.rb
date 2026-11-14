class ErrorSays < Nukadoko::Step
  description "The first line of stderr is exactly this"
  pattern "the error says {text:string}"
  args do
    string :text, "The expected first line of stderr"
    field :stderr, RunTally.returns[:stderr]
  end
  from stderr: [RunTally, :stderr]
  claims [{ actual: "stderr", view: "lines", at: "0", compare: "equal", expected: "text" }]
end
