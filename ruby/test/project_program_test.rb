# frozen_string_literal: true

require "nukadoko"
require "tmpdir"

# The program under test is the program lambda of nukadoko.config.rb. A
# change to it alone leaves the config's mapping as it was, and a project
# that still holds a program file of an earlier release is refused.
class ProjectProgramTest < Minitest::Test
  P = Nukadoko::Engine::ProjectProgram

  def config(program) = %(Nukadoko.config(\n  browser: { headless: true },\n  program: -> { #{program} },\n)\n)

  def test_a_change_to_the_program_alone_leaves_the_mapping_text
    one = config(%({ serve: { command: "ruby app.rb", ready: "/" } }))
    two = config(%({ serve: { command: "ruby app.rb --port {port}", ready: "/up" }, env: { A: "1" } }))
    assert_equal P.mapping_text(one), P.mapping_text(two)
    refute_includes P.mapping_text(one), "ruby app.rb"
    assert_includes P.mapping_text(one), "program: "
  end

  def test_a_change_beside_the_program_changes_the_mapping_text
    one = config("{}")
    refute_equal P.mapping_text(one), P.mapping_text(one.sub("headless: true", "headless: false"))
  end

  def test_two_program_keys_leave_the_text_whole
    text = "#{config("{}")}#{config("{ a: 1 }")}"
    assert_equal text, P.mapping_text(text)
  end

  def test_the_program_lambda_is_called_for_its_options
    assert_equal({ env: { SITE: "a" } }, P.called(-> { { env: { SITE: "a" } } }, "nukadoko.config.rb"))
    assert_nil P.called(nil, "nukadoko.config.rb")
    refusal = assert_raises(Nukadoko::Engine::Refusal) { P.called({ url: "x" }, "nukadoko.config.rb") }
    assert_equal "config-invalid", refusal.code
    assert_equal "Invalid config at nukadoko.config.rb: program: must be a lambda that returns the program", refusal.message
  end

  def test_a_program_file_of_an_earlier_release_is_refused
    Dir.mktmpdir do |dir|
      File.write(File.join(dir, "nukadoko.program.rb"), "Nukadoko.program(env: { SITE: \"a\" })\n")
      refusal = assert_raises(Nukadoko::Engine::Refusal) { P.read(dir) }
      assert_equal "program-file-moved", refusal.code
      assert_includes refusal.message, "nukadoko.program.rb is no longer read"
    end
  end

  def test_nukadoko_program_called_from_the_config_is_refused
    Dir.mktmpdir do |dir|
      File.write(File.join(dir, "nukadoko.config.rb"), "Nukadoko.config\nNukadoko.program(env: { SITE: \"a\" })\n")
      refusal = assert_raises(Nukadoko::Engine::Refusal) { Nukadoko.load_project(dir) }
      assert_equal "config-invalid", refusal.code
      assert_includes refusal.message, "Nukadoko.program is no longer read"
      File.write(File.join(dir, "nukadoko.config.rb"), "Nukadoko.config(program: -> { { env: { SITE: \"a\" } } })\n")
      Nukadoko.load_project(dir)
      assert_equal({ env: { SITE: "a" } }, Nukadoko.program_options)
    end
  end

  def test_a_tree_reads_the_copy_beside_its_config
    Dir.mktmpdir do |dir|
      File.write(File.join(dir, "nukadoko.tree-program.rb"), config(%({ env: { SITE: "other" } })))
      assert_equal({ env: { SITE: "other" } }, P.read(dir))
      File.write(File.join(dir, "nukadoko.tree-legacy-program.rb"), "Nukadoko.program(env: { SITE: \"old\" })\n")
      assert_equal({ env: { SITE: "old" } }, P.read(dir))
    end
  end
end
