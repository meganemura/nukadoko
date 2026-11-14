class GoB < Nukadoko::Step
  description "Go a number of steps, again"
  pattern "I go {b:int}"
  args { number :b, "The steps" }

  def run(args:) = {}
end
