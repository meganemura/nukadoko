class IsBelow < Nukadoko::Step
  description "One number is less than another"
  pattern "{a:int} is below {b:int}"
  args do
    number :a, "The number read"
    number :b, "The bound"
  end
  claims [{ actual: "value", compare: "less-than", expected: "b" }]

  def observe(args:) = { value: args.a }
end
