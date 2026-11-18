class InsideList < Nukadoko::Step
  pattern "a path inside the list"
  files written: { of: WriteNotes }
  claims [{ actual: "written.0", compare: "equal", expected: { literal: "notes/" } }]
end
