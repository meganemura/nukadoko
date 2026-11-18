class NothingWasWritten < Nukadoko::Step
  pattern "nothing was written"
  description "The program changed no file"
  files changed: { of: [WriteNotes, WriteMoreNotes] }
  claims [{ actual: "changed", compare: "equal", expected: { literal: [] } }]
end
