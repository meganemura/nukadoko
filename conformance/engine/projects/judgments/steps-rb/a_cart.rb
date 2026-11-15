class ACart < Nukadoko::Step
  pattern "a cart holds {count:int} items"
  description "A cart whose total the step works out"
  args { integer :count, "How many items" }
  returns { integer :total, "The total, worked out in the step" }
  mutates false

  def run(args:) = { total: args.count * 4 }
end
