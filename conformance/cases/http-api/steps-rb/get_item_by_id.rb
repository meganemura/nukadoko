class GetItemById < Nukadoko::Step
  description "GET /items/<id> for a literal id"
  pattern "I request item {id:int}"
  args { number :id, "The id in the path" }
  returns do
    number :status, "HTTP status"
    unknown :body, "The parsed JSON response"
  end
  mutates false

  def run(request:, args:)
    res = request.get("/items/#{args.id}")
    { status: res.status, body: res.json }
  end
end
