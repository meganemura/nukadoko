class BodyHasId < Nukadoko::Step
  description "The last response body holds an id the API assigned"
  pattern "the response body has an id of at least 1"
  args { unknown :body, "The body the last request got" }
  from body: [CreateItem, GetItem, GetItemById, ListItems].map { [_1, :body] }
  claims [{ actual: "body", at: "id", compare: "at-least", expected: { literal: 1 } }]
end
