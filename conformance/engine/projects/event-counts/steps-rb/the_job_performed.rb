class TheJobPerformed < Nukadoko::Step
  pattern "the job performed {n:int} times"
  description "The queued job performed this many times, as the job step's execution events say"
  args { integer :n, "How many times" }
  events performed: { of: AJobIsQueued, count: { kind: "job", phase: "perform" } }
  claims [{ actual: "performed", compare: "equal", expected: "n" }]
end
