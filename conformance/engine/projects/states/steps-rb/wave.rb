class Wave < Nukadoko::Step
  description "A person waves"
  pattern "{person:word} waves"
  args { string :person, "Who waves" }
  mutates false

  def run = nil
end
