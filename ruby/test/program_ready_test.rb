# frozen_string_literal: true

require "nukadoko"
require "tmpdir"

# A world is ready once its ready path answers 2xx, as in the TypeScript
# engine: a server that answers 503 while it warms up is not ready, and
# one that never answers 2xx stops the world with the last answer it gave.
# The program's shape is checked before anything starts.
class ProgramReadyTest < Minitest::Test
  # Answers STATUS (200 by default) to every request, after WARMUP
  # requests answered 503.
  SERVER = <<~RUBY
    require "socket"
    server = TCPServer.new("127.0.0.1", Integer(ENV.fetch("PORT")))
    seen = 0
    loop do
      client = server.accept
      client.gets
      seen += 1
      status = seen <= Integer(ENV.fetch("WARMUP", "0")) ? "503 Service Unavailable" : ENV.fetch("STATUS", "200 OK")
      client.write "HTTP/1.1 \#{status}\\r\\ncontent-length: 2\\r\\nconnection: close\\r\\n\\r\\nok"
      client.close
    end
  RUBY

  def program(serve, env = {})
    options = Nukadoko::Engine::ProgramShape.read({ serve: serve, env: { PORT: "{port}", **env } }, "nukadoko.config.rb")
    Nukadoko::Engine::Program.new(options)
  end

  def started(project, program)
    File.write(File.join(project, "server.rb"), SERVER)
    program.start(program.environments.first, Dir.mktmpdir, project)
  end

  def test_a_program_with_no_ready_path_is_ready_once_the_root_answers
    Dir.mktmpdir do |project|
      world = started(project, program({ command: "#{RbConfig.ruby} server.rb" }))
      begin
        assert_equal "ok", Net::HTTP.get(URI(world.base_url))
      ensure
        world.stop
      end
    end
  end

  def test_a_program_that_answers_503_first_is_ready_at_its_first_2xx
    Dir.mktmpdir do |project|
      world = started(project, program({ command: "#{RbConfig.ruby} server.rb" }, { WARMUP: "3" }))
      begin
        assert_equal "200", Net::HTTP.get_response(URI(world.base_url)).code
      ensure
        world.stop
      end
    end
  end

  def test_a_program_that_never_answers_2xx_does_not_start_and_says_what_it_last_answered
    Dir.mktmpdir do |project|
      error = assert_raises(Nukadoko::Engine::Program::StartFailed) do
        started(project, program({ command: "#{RbConfig.ruby} server.rb", ready: "/up", timeout_ms: 1500 }, { STATUS: "404 Not Found" }))
      end
      assert_match %r{did not answer http://localhost:\d+/up with a 2xx status within 1500 ms \(timeout_ms\); the last answer was 404}, error.cause_text
      assert_match(/\Athe program did not start for world default: /, error.message)
    end
  end

  def test_a_program_that_exits_first_names_its_exit_and_its_log
    Dir.mktmpdir do |project|
      error = assert_raises(Nukadoko::Engine::Program::StartFailed) do
        started(project, program({ command: [RbConfig.ruby, "-e", "warn %(no database); exit 3"] }))
      end
      assert_match(/exited with code 3 before/, error.cause_text)
      assert_match(/The end of .*program\.log:\n\$ .* -e 'warn %\(no database\); exit 3'\nno database\z/, error.message)
    end
  end

  def test_a_key_the_program_does_not_know_is_refused_with_the_key_it_matches_in_case
    error = assert_raises(Nukadoko::Engine::Refusal) do
      Nukadoko::Engine::ProgramShape.read({ serve: { command: "x", Ready: "/up" } }, "nukadoko.config.rb")
    end
    assert_equal "config-invalid", error.code
    assert_equal 'Invalid program at nukadoko.config.rb: unknown key(s): Ready (did you mean "ready"?)', error.message
  end

  def test_a_ready_path_that_names_another_host_is_refused
    error = assert_raises(Nukadoko::Engine::Refusal) do
      Nukadoko::Engine::ProgramShape.read({ serve: { command: "x", ready: "//example.com/up" } }, "nukadoko.config.rb")
    end
    assert_match(/program\.serve\.ready: must be a path on the world's own server/, error.message)
  end
end
