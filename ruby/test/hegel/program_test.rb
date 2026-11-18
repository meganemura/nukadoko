# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of how a world fills a program's placeholders, and of which
# ones it refuses before anything runs: text with no placeholder is left
# as written, a placeholder with a value never survives filling, build
# may name {root} and nothing else, and a URL check answers for any text.
class ProgramPropertiesTest < Minitest::Test
  include Hegel::Syntax::Methods

  P = Nukadoko::Engine::Program
  NAMES = %w[port url dir root world token].freeze
  WORDS = ["a", "b c", "-", "/", "{", "}", "{x}", "{ port}", "{Port}", "%", "$HOME", "é"].freeze

  def check(&) = Hegel.test(test_cases: 300, verbosity: :quiet, &)

  def recipe(build: [], prepare: [], env: {}, reach: { kind: "none" }, conditions: {})
    Nukadoko::Engine::Recipe.new(build: build.map { { command: _1, timeout_ms: 1 } }, prepare: prepare.map { { command: _1, timeout_ms: 1 } },
                                 reach: reach, env: env, setup: nil, conditions: conditions)
  end

  def test_text_with_no_placeholder_is_left_as_written
    check do |tc|
      text = Array.new(tc.draw(integers(min_value: 0, max_value: 6))) { tc.draw(sampled_from(WORDS)) }.join
      assert_equal text, P.filled(text, NAMES.to_h { [_1, "v"] }, {})
    end
  end

  def test_a_placeholder_with_a_value_never_survives_filling
    check do |tc|
      names = Array.new(tc.draw(integers(min_value: 1, max_value: 5))) { tc.draw(sampled_from(NAMES)) }
      text = names.map { "{#{_1}}" }.join(tc.draw(sampled_from(WORDS)))
      filled = P.filled(text, NAMES.to_h { [_1, "<#{_1}>"] }, {})
      names.each { refute_includes filled, "{#{_1}}" }
    end
  end

  def test_build_may_name_root_and_nothing_else
    check do |tc|
      names = Array.new(tc.draw(integers(min_value: 0, max_value: 5))) { tc.draw(sampled_from(NAMES)) }
      command = ["sh", *names.map { "{#{_1}}" }]
      gaps = P.placeholder_gaps(recipe(build: [command]))
      assert_equal (names.uniq - ["root"]).size, gaps.size, command.inspect
      gaps.each { assert_match(/\Abuild\[0\] names \{\w+\}, which has no value here: build runs once per tree/, _1) }
    end
  end

  def test_a_served_world_has_every_value_but_events
    check do |tc|
      names = Array.new(tc.draw(integers(min_value: 0, max_value: 5))) { tc.draw(sampled_from(NAMES)) }
      serve = { kind: "serve", serve: { command: "ruby app.rb" } }
      assert_empty P.placeholder_gaps(recipe(prepare: [["sh", *names.map { "{#{_1}}" }]], reach: serve, env: { "A" => names.map { "{#{_1}}" }.join })),
                   names.inspect
    end
  end

  def test_the_url_check_answers_for_any_text_and_refuses_a_user
    check do |tc|
      text = Array.new(tc.draw(integers(min_value: 0, max_value: 6))) { tc.draw(sampled_from(["http://", "https://", "ftp://", "a", "@", ":", "/", "localhost", "[::1]", " "])) }.join
      problem = P.url_problem(text)
      assert(problem.nil? || problem.is_a?(String))
      host = tc.draw(sampled_from(["localhost", "example.com", "127.0.0.1"]))
      assert_nil P.url_problem("http://#{host}:3000/a")
      assert_match(/must not hold a user or a password/, P.url_problem("https://user:pw@#{host}/").to_s)
    end
  end
end
