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

  def run(baseURL:, args:)
    res = Net::HTTP.get_response(URI("#{baseURL}/items/#{args.id}"))
    { status: res.code.to_i, body: JSON.parse(res.body) }
  end
end
