class TextIsString < Nukadoko::Step
  description "A refused claim"
  pattern "the note as text is a string"
  claims [{ actual: "note", view: "text", compare: "is-a", expected: { literal: "string" } }]

  def observe(args:) = {}
end
