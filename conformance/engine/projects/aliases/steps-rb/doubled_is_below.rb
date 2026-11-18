class DoubledIsBelow < Nukadoko::Step
  description "The number an earlier step doubled is less than a bound"
  pattern "the doubled number is below {bound:int}"
  args do
    number :bound, "The bound"
    field :doubled, Double.returns[:doubled]
  end
  from doubled: [Double, :doubled]
  claims [{ actual: "doubled", compare: "less-than", expected: "bound" }]
end
