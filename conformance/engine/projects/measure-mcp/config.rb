require "json"
require "net/http"

# A transport in the shape of the mcp gem's client transports:
# send_request returns the answer, and send_notification returns nothing.
class NotesTransport
  def initialize(url)
    @url = URI(url)
  end

  def send_request(request:)
    JSON.parse(Net::HTTP.post(@url, JSON.generate(request), "content-type" => "application/json").body)
  end

  def send_notification(notification:)
    Net::HTTP.post(@url, JSON.generate(notification), "content-type" => "application/json")
    nil
  end
end

# A transport that answers in the process, as a stdio server's would:
# nothing goes to the world.
class LocalTransport
  def send_request(request:)
    { "jsonrpc" => "2.0", "id" => request[:id], "result" => { "content" => [{ "type" => "text", "text" => "local" }] } }
  end
end

# The least a client does: number its requests and send them.
class NotesClient
  def initialize(transport)
    @transport = transport
    @next = 0
  end

  def call(method, params = nil)
    @next += 1
    @transport.send_request(request: { jsonrpc: "2.0", id: @next, method: method, **(params ? { params: params } : {}) })
  end

  def notify(method)
    @transport.send_notification(notification: { jsonrpc: "2.0", method: method })
  end
end

Nukadoko.fixture(:notes) do |use, base_url:|
  use.(NotesClient.new(Nukadoko.measure_mcp(NotesTransport.new("#{base_url}/mcp"))))
end

Nukadoko.fixture(:local_notes) do |use|
  use.(NotesClient.new(Nukadoko.measure_mcp(LocalTransport.new)))
end
