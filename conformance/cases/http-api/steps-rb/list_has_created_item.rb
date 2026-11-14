class ListHasCreatedItem < Nukadoko::Step
  description "The item list holds the item an earlier step created, id and name"
  pattern "the list has the item that was created"
  args do
    unknown :body, "The list the request got"
    field :created, AnItemExists.returns[:body]
  end
  from body: [ListItems, :body], created: [AnItemExists, :body]
  claims [{ actual: "body", compare: "has-item", expected: { from: "created" } }]
end
