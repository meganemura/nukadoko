class TextCompare < Nukadoko::Step
  pattern "the list contains {path:string}"
  args { string :path, "A path" }
  files written: { of: WriteNotes }
  claims [{ actual: "written", compare: "contains", expected: "path" }]
end
