class TheItemsArePeeked < Nukadoko::Step
  description "Look at the items, which records a visit"
  pattern "the items are peeked"
  returns { number :status, "The status the API answered" }
  mutates true

  def run(request:)
    { status: request.post("/peek").status }
  end
end
