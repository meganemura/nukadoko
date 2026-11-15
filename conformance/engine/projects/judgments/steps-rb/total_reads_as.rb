class TotalReadsAs < Nukadoko::Step
  pattern "the total reads as {quality:string}"
  description "The total, for a reader to judge against the quality"
  args do
    string :quality, "What the total should read as"
    field :total, ACart.returns[:total]
  end
  from total: [ACart, :total]
  claims [{ actual: "total", compare: "judged-as", expected: "quality" }]
end
