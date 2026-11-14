class MakeThing < Nukadoko::Step
  description "Makes a thing"
  pattern "a thing is made"
  returns do
    string :thing, "The thing"
  end
  mutates false

  def run(args:) = { thing: "a" }
end
