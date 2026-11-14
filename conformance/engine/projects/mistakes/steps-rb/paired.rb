class Paired < Nukadoko::Step
  description "A pattern that captures one key twice"
  pattern "I pair {a:int} and {a:int}"
  args { number :a, "A number" }

  def run(args:) = {}
end
