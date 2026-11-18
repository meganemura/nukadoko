class ClimbsOut < Nukadoko::Step
  pattern "a list climbs out"
  files written: { of: WriteNotes, under: "../x" }
  claims [{ actual: "written", compare: "equal", expected: { literal: [] } }]
end
