class CopyTheSample < Nukadoko::Step
  description "Copy the sample directory into scratch and read its note back"
  pattern "the sample is copied"
  returns { string :note, "The note in the copy" }
  # Writes only under scratch.
  mutates false

  def run(scratch:)
    { note: File.read(File.join(scratch.copy("sample"), "note.txt")).strip }
  end
end
