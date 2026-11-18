class Light < Nukadoko::Step
  description "Someone lights the hall"
  pattern "the hall is lit"
  requires "inside"
  mutates false

  def run = nil
end
