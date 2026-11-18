class UnreadKey < Nukadoko::Step
  pattern "a key nothing reads"
  args { string :path, "A path" }
  files written: { of: WriteNotes }, other: { of: WriteNotes }
  claims [{ actual: "written", compare: "has-item", expected: "path" }]
end
