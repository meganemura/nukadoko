class TheShopAnswered < Nukadoko::Step
  pattern "the shop answered {n:int} time"
  description "The asking step was served this many requests, as the shop's execution events say"
  args { integer :n, "How many requests" }
  events requests: { of: TheShopIsAskedAt, count: { kind: "request" } }
  claims [{ actual: "requests", compare: "equal", expected: "n" }]
end
