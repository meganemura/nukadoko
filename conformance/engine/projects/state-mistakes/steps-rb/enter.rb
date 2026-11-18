class Enter < Nukadoko::Step
  description "A person enters the hall"
  pattern "{person:word} enters"
  args { string :person, "Who enters" }
  gives ["inside", :person]
  mutates false

  def run = nil
end
