class BodyIsCreatedItem < Nukadoko::Step
  description "The last response body is the item an earlier step created, id and name"
  pattern "the response body is the item that was created"
  args do
    unknown :body, "The body the read got"
    field :created, AnItemExists.returns[:body]
  end
  from body: [GetItem, :body], created: [AnItemExists, :body]
  claims [{ actual: "body", compare: "equal", expected: { from: "created" } }]
end
