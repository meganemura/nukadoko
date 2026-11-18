class Count < Nukadoko::Step
  description "Count to a number"
  pattern "I count to {n:int}"
  patterns "I count"
  args { number :n, "The number to count to" }
  mutates false

  def run(args:) = {}
end
