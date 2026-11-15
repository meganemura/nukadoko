# frozen_string_literal: true

require "nukadoko"
require "stringio"
require "tmpdir"

# `nuka init` gives a Ruby project one command for people and CI: a
# `scenarios` task in the Rakefile it already has.
class InitTest < Minitest::Test
  def init(dir)
    out = StringIO.new
    code = Nukadoko::Engine::Init.new(dir, out: out, err: StringIO.new).call
    [code, out.string.lines.map(&:chomp)]
  end

  def test_a_rakefile_gets_a_scenarios_task
    Dir.mktmpdir do |dir|
      File.write(File.join(dir, "Rakefile"), "task default: :test\n")
      code, written = init(dir)
      assert_equal 0, code
      assert_includes written, "Rakefile"
      assert_equal "task default: :test\n\n#{Nukadoko::Engine::Init::TASK}", File.read(File.join(dir, "Rakefile"))
    end
  end

  def test_a_rakefile_with_a_scenarios_task_is_kept
    Dir.mktmpdir do |dir|
      File.write(File.join(dir, "Rakefile"), "task :scenarios do\nend\n")
      _, written = init(dir)
      refute_includes written, "Rakefile"
      assert_equal "task :scenarios do\nend\n", File.read(File.join(dir, "Rakefile"))
    end
  end

  def test_no_rakefile_is_written
    Dir.mktmpdir do |dir|
      _, written = init(dir)
      refute_includes written, "Rakefile"
      refute File.exist?(File.join(dir, "Rakefile"))
    end
  end
end
