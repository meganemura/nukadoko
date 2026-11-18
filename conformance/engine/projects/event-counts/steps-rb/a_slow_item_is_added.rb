class ASlowItemIsAdded < Nukadoko::Step
  description "Add an item through the API, whose lines the program writes later"
  pattern "a slow item is added"
  returns { number :status, "The status the API answered" }
  mutates true

  def run(request:)
    { status: request.post("/slow-items").status }
  end
end
