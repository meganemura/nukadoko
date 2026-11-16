# frozen_string_literal: true

require "nukadoko"
require "socket"

# The request fixture goes to an absolute URL as named, and joins a path onto
# the world's URL; with no world URL a path is refused with a reason.
class RequestFixtureTest < Minitest::Test
  def with_server
    server = TCPServer.new("127.0.0.1", 0)
    thread = Thread.new do
      client = server.accept
      line = client.gets.to_s
      nil until client.gets.to_s.strip.empty?
      body = line.split[1].to_s
      client.write("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: #{body.bytesize}\r\nconnection: close\r\n\r\n#{body}")
      client.close
    end
    yield "http://127.0.0.1:#{server.addr[1]}"
  ensure
    thread&.join(5)
    server&.close
  end

  def test_an_absolute_url_needs_no_world_url
    with_server do |origin|
      request = Nukadoko::Engine::Request.new(nil)
      response = request.get("#{origin}/todos?open=1")
      assert_equal "/todos?open=1", response.body
      assert_equal "#{origin}/todos?open=1", request.log.first[:url]
      assert_equal "request", request.log.first[:via]
    end
  end

  def test_a_path_with_no_world_url_is_refused
    error = assert_raises(ArgumentError) { Nukadoko::Engine::Request.new(nil).get("/todos") }
    assert_includes error.message, "no base URL"
  end

  def test_a_path_joins_the_world_url
    with_server do |origin|
      request = Nukadoko::Engine::Request.new(origin)
      assert_equal "/items", request.get("/items").body
    end
  end
end
