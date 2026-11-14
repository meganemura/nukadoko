class BodyHasName < Nukadoko::Step
  description "The last response body's name is exactly this"
  pattern "the response body has the name {name:string}"
  args do
    string :name, "The expected name"
    unknown :body, "The body the last request got"
  end
  from body: [CreateItem, GetItem, GetItemById, ListItems].map { [_1, :body] }
  claims [{ actual: "body", at: "name", compare: "equal", expected: "name" }]
end
