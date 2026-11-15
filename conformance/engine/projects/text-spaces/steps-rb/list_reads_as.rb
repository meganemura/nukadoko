class ListReadsAs < Nukadoko::Step
  description "A text read through the comma-list view is this list"
  pattern "the list {actual:string} reads as {expected:string}"
  args do
    string :actual, "The value read, with \\uXXXX for a character"
    string :expected, "The expected list, as JSON"
  end
  claims [{ actual: "value", view: "comma-list", compare: "equal", expected: "expected", expected_view: "json" }]

  def observe(args:) = { value: args.actual.gsub(/\\u(\h{4})/) { ::Regexp.last_match(1).to_s.hex.chr("UTF-8") } }
end
