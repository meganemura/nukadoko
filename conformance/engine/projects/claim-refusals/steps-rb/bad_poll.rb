class BadPoll < Nukadoko::Step
  description "A refused claim"
  pattern "the badge is {text:string}"
  args do
    string :text, "The text"
  end
  claims [{ actual: "badge", compare: "equal", expected: "text" }]
  poll({ timeout_ms: 0 })

  def observe(args:) = {}
end
