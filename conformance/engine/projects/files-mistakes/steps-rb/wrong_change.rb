class WrongChange < Nukadoko::Step
  pattern "a change that is no change"
  files written: { of: WriteNotes, change: "moved" }
  claims [{ actual: "written", compare: "equal", expected: { literal: [] } }]
end
