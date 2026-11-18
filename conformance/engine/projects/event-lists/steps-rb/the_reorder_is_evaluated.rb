class TheReorderIsEvaluated < Nukadoko::Step
  description "Evaluate the quick reorder flag on one side"
  pattern "the reorder is evaluated {side:string}"
  args { string :side, "The side the program evaluates" }
  returns { number :status, "The status the API answered" }

  def run(request:, args:)
    { status: request.post("/reorder/#{args.side}").status }
  end
end
