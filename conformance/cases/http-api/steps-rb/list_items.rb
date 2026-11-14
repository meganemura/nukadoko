class ListItems < Nukadoko::Step
  description "GET /items"
  pattern "I request the item list"
  returns do
    number :status, "HTTP status"
    unknown :body, "The parsed JSON response"
  end
  mutates false

  def run(baseURL:, args:)
    res = Net::HTTP.get_response(URI("#{baseURL}/items"))
    { status: res.code.to_i, body: JSON.parse(res.body) }
  end
end
