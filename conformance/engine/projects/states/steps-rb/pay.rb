class Pay < Nukadoko::Step
  description "A person pays for an open book"
  pattern "{person:word} pays"
  args { string :person, "Who pays" }
  requires "book-open", "paid"
  mutates false

  def run = nil
end
