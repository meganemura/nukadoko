class GetItem < Nukadoko::Step
  description "GET /items/<id> for the item an earlier step created"
  pattern "I request that item"
  args { field :id, AnItemExists.returns[:id] }
  from id: [AnItemExists, :id]
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
