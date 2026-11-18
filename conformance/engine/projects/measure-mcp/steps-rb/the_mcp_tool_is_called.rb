class TheMcpToolIsCalled < Nukadoko::Step
  description "Call a tool of the notes server over MCP"
  pattern "the MCP tool {tool:string} is called"
  args { string :tool, "The tool's name" }
  returns { string :text, "The text of the tool's answer" }
  mutates false

  def run(notes:, args:)
    answer = notes.call("tools/call", { name: args.tool, arguments: { text: "milk" } })
    { text: answer.dig("result", "content", 0, "text") }
  end
end
