class NothingWasWritten < Nukadoko::Step
  pattern "nothing was written"
  description "The item step wrote no row, as its execution events say"
  events writes: { of: AnItemIsAdded, count: { kind: "db", op: %w[insert update delete other], committed: true } }
  claims [{ actual: "writes", compare: "equal", expected: { literal: 0 } }]
end
