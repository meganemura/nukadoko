class BodyHasCount < Nukadoko::Step
  description "The item count the API answered is at least 1"
  pattern "the response body has a count of at least 1"
  args { unknown :body, "The body the count request got" }
  from body: [CountItems, :body]
  claims [{ actual: "body", at: "count", compare: "at-least", expected: { literal: 1 } }]
end
