class StatusIs < Nukadoko::Step
  description "The last response's HTTP status is exactly this"
  pattern "the response status is {expected:int}"
  args do
    number :expected, "The expected HTTP status"
    number :status, "The status the last request got"
  end
  from status: [CreateItem, GetItem, GetItemById, ListItems, CountItems].map { [_1, :status] }
  claims [{ actual: "status", compare: "equal", expected: "expected" }]
end
