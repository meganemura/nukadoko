class SignIn < Nukadoko::Step
  description "A person signs in"
  pattern "{person:word} signs in"
  args { string :person, "Who signs in" }
  gives ["signed-in", :person]
  mutates false

  def run = nil
end
