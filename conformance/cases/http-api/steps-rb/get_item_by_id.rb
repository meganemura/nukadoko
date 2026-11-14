class GetItemById < Nukadoko::Step
  description "GET /items/<id> for a literal id"
  pattern "I request item {id:int}"
  args { number :id, "The id in the path" }
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
