# frozen_string_literal: true

require "nukadoko"
require "tmpdir"

# `scratch.copy` gives a step a fresh directory that already holds a copy of
# what it names, resolved against the project, as the TypeScript engine's does.
class ScratchTest < Minitest::Test
  def with_project
    Dir.mktmpdir do |project|
      FileUtils.mkdir_p(File.join(project, "example", "spec"))
      File.write(File.join(project, "example", "spec", "a_spec.rb"), "spec\n")
      File.write(File.join(project, "notes.txt"), "notes\n")
      yield project, Nukadoko::Engine::Scratch.new(project)
    end
  end

  def test_a_directory_is_copied_by_its_contents
    with_project do |_project, scratch|
      copy = scratch.copy("example")
      assert_equal "spec\n", File.read(File.join(copy, "spec", "a_spec.rb"))
      assert_equal [copy], scratch.dirs
    end
  end

  def test_a_file_keeps_its_name
    with_project do |_project, scratch|
      copy = scratch.copy("notes.txt")
      assert_equal ["notes.txt"], Dir.children(copy)
    end
  end

  def test_a_missing_source_raises_and_makes_no_directory
    with_project do |_project, scratch|
      assert_raises(Errno::ENOENT) { scratch.copy("nope") }
      assert_empty scratch.dirs
    end
  end
end
