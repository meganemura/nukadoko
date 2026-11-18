class OpenABook < Nukadoko::Step
  description "A signed-in person opens a book"
  pattern "{person:word} opens a book"
  args { string :person, "Who opens it" }
  requires ["signed-in", :person]
  gives "book-open"
  mutates false

  def run = nil
end
