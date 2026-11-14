class MisspelledAt < Nukadoko::Step
  description "A refused claim"
  pattern "the reply is {text:string}"
  args do
    string :text, "The text"
  end
  claims [{ actual: "reply", ar: "body", compare: "equal", expected: "text" }]

  def observe(args:) = {}
end
