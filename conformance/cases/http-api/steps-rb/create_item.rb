class CreateItem < Nukadoko::Step
  description "POST /items with this JSON body, verbatim"
  pattern "I POST this body to \\/items"
  args { string :body, "The request body, sent as-is" }
  returns do
    number :status, "HTTP status"
    unknown :body, "The parsed JSON response"
  end

  def run(request:, args:)
    res = request.post("/items", body: args.body)
    { status: res.status, body: res.json }
  end
end
