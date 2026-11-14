class CountMatches < Nukadoko::Step
  description "A refused claim"
  pattern "the rows count {n:int}"
  args do
    integer :n, "The n"
  end
  claims [{ actual: "rows", count: true, compare: "matches", expected: "n" }]

  def observe(args:) = {}
end
