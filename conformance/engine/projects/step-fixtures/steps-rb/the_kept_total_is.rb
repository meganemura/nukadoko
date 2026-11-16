class TheKeptTotalIs < Nukadoko::Step
  description "The total kept is the number the line states"
  pattern "the kept total is {expected:int}"
  args do
    integer :expected, "The total the line expects"
    field :total, WaitAndKeep.returns[:total]
  end
  from total: [WaitAndKeep, :total]
  claims [{ actual: "total", compare: "equal", expected: "expected" }]
end
