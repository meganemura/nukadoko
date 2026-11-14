class KeptNoteReads < Nukadoko::Step
  description "The kept note"
  pattern "the kept note is a string"
  args do
    string :kept, "The kept note"
    string :text, "What the line says"
  end
  from kept: [KeepNote, :note]
  claims [{ actual: "kept", compare: "is-a", expected: { literal: "string" } }]
end
