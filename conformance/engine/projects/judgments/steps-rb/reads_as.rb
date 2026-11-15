class ReadsAs < Nukadoko::Step
  pattern "the greeting reads as {quality:string}"
  description "The greeting, for a reader to judge against the quality"
  args do
    string :quality, "What the greeting should read as"
    field :stdout, RunGreet.returns[:stdout]
  end
  from stdout: [RunGreet, :stdout]
  claims [{ actual: "stdout", view: "text", compare: "judged-as", expected: "quality" }]
end
