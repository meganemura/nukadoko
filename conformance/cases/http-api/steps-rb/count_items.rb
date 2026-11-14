class CountItems < Nukadoko::Step
  description "GET /items/count"
  pattern "I request the item count"
  returns do
    number :status, "HTTP status"
    unknown :body, "The parsed JSON response"
  end
  mutates false

  def run(request:, args:)
    res = request.get("/items/count")
    { status: res.status, body: res.json }
  end
end
