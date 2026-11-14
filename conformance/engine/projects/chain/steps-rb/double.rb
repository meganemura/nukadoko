class Double < Nukadoko::Step
  description "Double a number"
  pattern "I double {n:int}"
  args { number :n, "The number to double" }
  returns { number :doubled, "Twice the number" }
  mutates false

  # 1000 stands for a number the program under test cannot take.
  def run(args:)
    raise "too big" if args.n == 1000

    { doubled: args.n * 2 }
  end
end
