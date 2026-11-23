class ShelveBook < Nukadoko::Step
  description "Put a book on the shelf, through one part"
  pattern "a book titled {title:string} is shelved"
  args { string :title, "The title of the book" }
  mutates true
  parts [PlaceBook]

  def run(call:, args:)
    call.(PlaceBook, title: args.title)
    {}
  end
end
