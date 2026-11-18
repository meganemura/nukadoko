class SignOut < Nukadoko::Step
  description "A person signs out"
  pattern "{person:word} signs out"
  args { string :person, "Who signs out" }
  ends ["signed-in", :person]
  mutates false

  def run = nil
end
