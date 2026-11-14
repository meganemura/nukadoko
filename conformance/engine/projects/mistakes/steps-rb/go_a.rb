class GoA < Nukadoko::Step
  description "Go a number of steps"
  pattern "I go {a:int}"
  args { number :a, "The steps" }

  def run(args:) = {}
end
