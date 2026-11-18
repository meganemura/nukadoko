class Repeat < Nukadoko::Step
  description "Someone repeats"
  pattern "someone repeats"
  requires "inside", " inside"
  mutates false

  def run = nil
end
