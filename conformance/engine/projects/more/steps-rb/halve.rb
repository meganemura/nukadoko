class Halve < Nukadoko::Step
  description "Halve a doubled number"
  pattern "I halve the number {doubled:int}"
  args { field :doubled, Double.returns[:doubled] }
  returns { number :half, "Half the number" }
  from doubled: [Double, :doubled]
  mutates false

  def run(args:) = { half: args.doubled / 2 }
end
