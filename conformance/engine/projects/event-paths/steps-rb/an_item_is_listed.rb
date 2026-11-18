class AnItemIsListed < Nukadoko::Step
  description "List the items"
  pattern "an item is listed"
  returns { number :status, "The status the API answered" }
  mutates false

  def run(request:)
    { status: request.post("/list").status }
  end
end
