class Waited < Nukadoko::Step
  description "A number capture the args read as a string"
  pattern "I wait {n:int} seconds"
  args { string :n, "The seconds" }

  def run(args:) = {}
end
