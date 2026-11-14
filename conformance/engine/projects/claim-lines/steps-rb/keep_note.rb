class KeepNote < Nukadoko::Step
  description "Keeps a note"
  pattern "a note is kept"
  returns do
    string :note, "The note"
  end
  mutates false

  def run(args:) = { note: "hello" }
end
