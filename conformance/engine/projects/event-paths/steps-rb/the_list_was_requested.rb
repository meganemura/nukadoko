class TheListWasRequested < Nukadoko::Step
  pattern "the list was requested {n:int} time"
  description "The list step sent this many requests, as its execution events say"
  args { integer :n, "How many requests" }
  events requests: { of: AnItemIsListed, count: { kind: "request" } }
  claims [{ actual: "requests", compare: "equal", expected: "n" }]
end
