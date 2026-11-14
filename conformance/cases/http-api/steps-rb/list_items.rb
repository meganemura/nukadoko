class ListItems < Nukadoko::Step
  description "GET /items"
  pattern "I request the item list"
  returns do
    number :status, "HTTP status"
    unknown :body, "The parsed JSON response"
  end
  mutates false

  def run(request:, args:)
    res = request.get("/items")
    { status: res.status, body: res.json }
  end
end
