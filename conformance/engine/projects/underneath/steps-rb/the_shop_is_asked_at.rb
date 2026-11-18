class TheShopIsAskedAt < Nukadoko::Step
  description "Ask the shop at a path, whatever it answers"
  pattern "the shop is asked at {path:string}"
  args { string :path, "The path under /ask" }
  returns { number :status, "The status the shop answered" }
  mutates false

  def run(request:, args:)
    { status: request.post(args.path).status }
  end
end
