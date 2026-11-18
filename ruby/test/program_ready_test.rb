# frozen_string_literal: true

require "nukadoko"
require "tmpdir"

# A serve block with no ready path waits for "/", so the command alone is
# enough to start a program.
class ProgramReadyTest < Minitest::Test
  SERVER = <<~RUBY
    require "socket"
    server = TCPServer.new("127.0.0.1", Integer(ENV.fetch("PORT")))
    loop do
      client = server.accept
      client.gets
      client.write "HTTP/1.1 200 OK\\r\\ncontent-length: 2\\r\\nconnection: close\\r\\n\\r\\nok"
      client.close
    end
  RUBY

  def test_a_program_with_no_ready_path_is_ready_once_the_root_answers
    Dir.mktmpdir do |project|
      File.write(File.join(project, "server.rb"), SERVER)
      program = Nukadoko::Engine::Program.new({ serve: { command: "#{RbConfig.ruby} server.rb" }, env: { PORT: "{port}" } })
      world = program.start(program.environments.first, Dir.mktmpdir, project)
      begin
        assert_equal "ok", Net::HTTP.get(URI(world.base_url))
      ensure
        world.stop
      end
    end
  end
end
