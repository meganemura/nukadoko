class AnUnknownMcpMethodIsCalled < Nukadoko::Step
  description "Call a method the notes server does not know over MCP"
  pattern "an unknown MCP method is called"
  mutates false

  def run(notes:) = notes.call("notes/nope") && nil
end
