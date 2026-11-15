class WordReadsAs < Nukadoko::Step
  description "A word the line gives is this text"
  pattern "the word {given:word} reads as {expected:string}"
  args do
    string :given, "The value the line gives"
    string :expected, "The expected side"
  end
  claims [{ actual: "value", compare: "equal", expected: "expected" }]

  def observe(args:) = { value: args.given }
end
