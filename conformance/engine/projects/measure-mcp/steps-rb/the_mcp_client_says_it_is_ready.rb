class TheMcpClientSaysItIsReady < Nukadoko::Step
  description "Send the notes server the notification that the client is ready"
  pattern "the MCP client says it is ready"
  mutates false

  def run(notes:) = notes.notify("notifications/initialized")
end
