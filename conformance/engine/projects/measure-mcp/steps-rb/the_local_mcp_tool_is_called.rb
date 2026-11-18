class TheLocalMcpToolIsCalled < Nukadoko::Step
  description "Call a tool of a server that answers in the process, as a stdio server does"
  pattern "the local MCP tool is called"
  mutates false

  def run(local_notes:) = local_notes.call("tools/call", { name: "add_note", arguments: { text: "milk" } }) && nil
end
