class TheItemsAreMailed < Nukadoko::Step
  description "Mail the items, which enqueues a job"
  pattern "the items are mailed"
  returns { number :status, "The status the API answered" }
  mutates true

  def run(request:)
    { status: request.post("/mail").status }
  end
end
