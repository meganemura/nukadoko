class TheValueIsBelow < Nukadoko::Step
  description "The number in value.txt, the program's one output, is less than a bound"
  pattern "the value is below {b:int}"
  args do
    number :b, "The bound"
  end
  claims [{ actual: "value", compare: "less-than", expected: "b" }]

  # features/scale.txt, when there is one, is part of the mapping: it divides the value.
  def observe(args:) = { value: Integer(File.read("value.txt").strip) / (File.exist?("features/scale.txt") ? Integer(File.read("features/scale.txt").strip) : 1) }
end
