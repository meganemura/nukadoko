class LinesHasFields < Nukadoko::Step
  description "A refused claim"
  pattern "the log has fields {fields:string}"
  args do
    string :fields, "The fields"
  end
  claims [{ actual: "log", view: "lines", compare: "has-fields", expected: "fields", expected_view: "json" }]

  def observe(args:) = {}
end
