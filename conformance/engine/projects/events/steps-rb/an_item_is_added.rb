class AnItemIsAdded < Nukadoko::Step
  description "Add an item through the API"
  pattern "an item is added"
  returns { number :status, "The status the API answered" }
  mutates true

  def run(request:)
    { status: request.post("/items").status }
  end
end
