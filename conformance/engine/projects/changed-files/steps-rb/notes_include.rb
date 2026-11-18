class NotesInclude < Nukadoko::Step
  pattern "the notes include {path:string}"
  description "The notes the program added include one path"
  args { string :path, "A path under notes/" }
  files written: { of: WriteNotes, change: "added", under: "notes" }
  claims [{ actual: "written", compare: "has-item", expected: "path" }]
end
