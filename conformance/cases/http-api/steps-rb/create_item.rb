class CreateItem < Nukadoko::Step
  description "POST /items with this JSON body, verbatim"
  pattern "I POST this body to \\/items"
  args { string :body, "The request body, sent as-is" }
  returns do
    number :status, "HTTP status"
    unknown :body, "The parsed JSON response"
  end

  def run(baseURL:, args:)
    res = Net::HTTP.post(URI("#{baseURL}/items"), args.body)
    { status: res.code.to_i, body: JSON.parse(res.body) }
  end
end
