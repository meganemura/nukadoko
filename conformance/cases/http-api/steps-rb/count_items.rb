class CountItems < Nukadoko::Step
  description "GET /items/count"
  pattern "I request the item count"
  returns do
    number :status, "HTTP status"
    unknown :body, "The parsed JSON response"
  end
  mutates false

  def run(baseURL:, args:)
    res = Net::HTTP.get_response(URI("#{baseURL}/items/count"))
    { status: res.code.to_i, body: JSON.parse(res.body) }
  end
end
