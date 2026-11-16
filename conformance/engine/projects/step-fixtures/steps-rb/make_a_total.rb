class MakeATotal < Nukadoko::Step
  description "Make a total of the number the line states"
  pattern "a total of {total:int} is made"
  args { integer :total, "The total to make" }
  returns { integer :total, "The total made" }
  # Keeps nothing.
  mutates false

  def run(args:) = { total: args.total }
end
