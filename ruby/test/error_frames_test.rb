# frozen_string_literal: true

require "nukadoko"
require "fileutils"
require "tmpdir"

# Which frames of a raised error's backtrace a failed step record keeps as
# `error.at`.
class ErrorFramesTest < Minitest::Test
  def test_keeps_the_project_frames_relative_to_the_root
    Dir.mktmpdir do |root|
      helper = File.join(root, "features", "steps", "lib", "todos.rb")
      FileUtils.mkdir_p(File.dirname(helper))
      File.write(helper, "module Todos\n  def self.pick(one) = one\nend\n")
      load helper
      error = begin
        Todos.pick(1, 2)
      rescue ArgumentError => e
        e
      end
      frames = Nukadoko::Engine::ErrorFrames.of(error, root)
      assert_equal "features/steps/lib/todos.rb:2", frames.first
      assert frames.none? { _1.start_with?("/") }
      assert_operator frames.size, :<=, Nukadoko::Engine::ErrorFrames::MAX
    end
  end

  def test_leaves_out_frames_outside_the_root
    error = begin
      Integer("x")
    rescue ArgumentError => e
      e
    end
    assert_equal [], Nukadoko::Engine::ErrorFrames.of(error, Dir.tmpdir)
  end
end
