class BodyIs < Nukadoko::Step
  description "The last response body, as JSON, deep-equals the docstring's JSON"
  pattern "the response body is"
  args do
    string :expected, "The expected body as JSON text"
    unknown :body, "The body the last request got"
  end
  from body: [CreateItem, GetItem, GetItemById, ListItems].map { [_1, :body] }
  claims [{ actual: "body", compare: "equal", expected: "expected", expected_view: "json" }]
end
