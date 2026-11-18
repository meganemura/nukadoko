class ActingStep < Nukadoko::Step
  pattern "an acting step reads files"
  files written: { of: WriteNotes }
  mutates false

  def run = nil
end
