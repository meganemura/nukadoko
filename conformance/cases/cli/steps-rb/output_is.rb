class OutputIs < Nukadoko::Step
  description "stdout is exactly the docstring, ignoring a trailing newline"
  pattern "the output is"
  args do
    string :expected, "The expected stdout, verbatim"
    field :stdout, RunTally.returns[:stdout]
  end
  from stdout: [RunTally, :stdout]
  # The program ends its output with a newline that the feature line does not show.
  claims [{ actual: "stdout", view: "text", compare: "equal", expected: "expected" }]
end
