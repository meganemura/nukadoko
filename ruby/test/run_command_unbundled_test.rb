# frozen_string_literal: true

require "nukadoko"
require "rbconfig"

# run_command(unbundled: true) gives the child the environment from before
# Bundler set up the runner, for a command in another Ruby project.
class RunCommandUnbundledTest < Minitest::Test
  PRINT = 'print [ENV["BUNDLE_GEMFILE"].inspect, ENV.fetch("RUBYOPT", "").include?("bundler/setup"), ENV["KEPT"]].join(" ")'

  def test_unbundled_drops_what_bundler_added_and_keeps_the_step_env
    skip "runs only under bundle exec" unless ENV["BUNDLE_GEMFILE"]

    out = Nukadoko.run_command(RbConfig.ruby, ["-e", PRINT], env: { "KEPT" => "yes" }, unbundled: true)[:stdout]
    assert_equal "nil false yes", out
  end

  def test_bundled_by_default
    skip "runs only under bundle exec" unless ENV["BUNDLE_GEMFILE"]

    out = Nukadoko.run_command(RbConfig.ruby, ["-e", PRINT])[:stdout]
    assert_equal ENV["BUNDLE_GEMFILE"].inspect, out.split(" ").first
  end
end
