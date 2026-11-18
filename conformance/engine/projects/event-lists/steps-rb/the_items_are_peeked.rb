class TheItemsArePeeked < Nukadoko::Step
  description "Look at the items, which the step declares changes nothing"
  pattern "the items are peeked"
  returns { number :status, "The status the API answered" }
  mutates false

  def run(request:)
    { status: request.post("/peek").status }
  end
end
