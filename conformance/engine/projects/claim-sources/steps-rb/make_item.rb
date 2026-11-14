class MakeItem < Nukadoko::Step
  description "Makes an item"
  pattern "an item is made"
  returns do
    object(:item, "The item") do
      number :id, "Its id"
      string :name, "Its name"
    end
    string :tags, "Its tags"
  end
  mutates false

  def run(args:) = { item: { id: 1, name: "a" }, tags: "x,y" }
end
