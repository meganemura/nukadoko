class ReadAs < Nukadoko::Step
  description "A text read through the text view is this text"
  pattern "the text {actual:string} reads as {expected:string}"
  args do
    string :actual, "The value read, with \\uXXXX for a character"
    string :expected, "The expected side"
  end
  claims [{ actual: "value", view: "text", compare: "equal", expected: "expected" }]

  def observe(args:) = { value: args.actual.gsub(/\\u(\h{4})/) { ::Regexp.last_match(1).to_s.hex.chr("UTF-8") } }
end
