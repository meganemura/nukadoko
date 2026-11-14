class MakeList < Nukadoko::Step
  description "Makes a list"
  pattern "a list is made"
  returns do
    strings :items, "The items"
    string :name, "Its name"
  end
  mutates false

  def run(args:) = { items: %w[a b c], name: "abc" }
end
