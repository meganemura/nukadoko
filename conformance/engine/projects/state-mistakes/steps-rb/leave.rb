class Leave < Nukadoko::Step
  description "A person leaves"
  pattern "{person:word} leaves"
  args { string :person, "Who leaves" }
  gives ["outside", :person]
  ends ["outside", :person]
  mutates false

  def run = nil
end
