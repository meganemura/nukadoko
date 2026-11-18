# An MCP client made on a transport built inside its own new call: nothing
# can wrap that transport in measure_mcp. `nuka check` only reads this.
class TheNotesAreRead < Nukadoko::Step
  description "Read the notes over MCP from a server the step starts"
  pattern "the notes are read"
  mutates false

  def run
    client = MCP::Client.new(transport: MCP::Client::Stdio.new(command: "notes-server"))
    client.call_tool(name: "read_notes")
    nil
  end
end
