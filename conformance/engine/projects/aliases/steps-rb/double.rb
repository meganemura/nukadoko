class Double < Nukadoko::Step
  description "Double a number"
  pattern "I double {n:int}"
  patterns "twice {n:int}"
  args { number :n, "The number to double" }
  returns { number :doubled, "Twice the number" }
  mutates false

  def run(args:) = { doubled: args.n * 2 }
end
