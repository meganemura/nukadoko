class PlaceBook < Nukadoko::Step
  description "Place one book; a part with no pattern of its own"
  args { string :title, "The title of the book" }
  mutates true

  def run = {}
end
