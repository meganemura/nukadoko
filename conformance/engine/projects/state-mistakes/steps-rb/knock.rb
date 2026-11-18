class Knock < Nukadoko::Step
  description "Someone knocks"
  pattern "someone knocks"
  requires ["inside", :door]
  mutates false

  def run = nil
end
