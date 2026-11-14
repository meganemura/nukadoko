class Fits < Nukadoko::Step
  description "The output read fits the docstring"
  pattern "the output {actual:string} fits"
  args do
    string :actual, "The value read, as text"
    string :text, "The expected side"
  end
  claims [{ actual: "value", compare: "fits-text", expected: "text" }]

  def observe(args:) = { value: args.actual.gsub("\\n", "\n") }
end
