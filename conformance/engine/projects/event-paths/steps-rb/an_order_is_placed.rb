class AnOrderIsPlaced < Nukadoko::Step
  description "Place an order, which fails when the API refuses it"
  pattern "an order is placed"
  returns { number :status, "The status the API answered" }
  mutates true

  def run(request:)
    status = request.post("/orders").status
    raise "the order was refused with #{status}" unless status == 201

    { status: status }
  end
end
