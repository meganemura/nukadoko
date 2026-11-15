class TextMatches < Nukadoko::Step
  description "The text read matches this pattern"
  pattern "the text {actual:string} matches {pattern:string}"
  args do
    string :actual, "The value read, with \\uXXXX for a character"
    string :pattern, "The pattern, as JavaScript reads it"
  end
  claims [{ actual: "value", compare: "matches", expected: "pattern" }]

  def observe(args:) = { value: args.actual.gsub(/\\u(\h{4})/) { ::Regexp.last_match(1).to_s.hex.chr("UTF-8") } }
end
