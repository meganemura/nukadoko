# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of the names and ids Allure results carry: a result's history
# does not depend on the order its parameters were listed in, an excluded
# parameter never joins it, and a file's name is a version 8 UUID that one
# key and place always give the same way.
class ReportAllureTest < Minitest::Test
  include Hegel::Syntax::Methods

  A = Nukadoko::Engine::ReportAllure
  NAMES = ["environment", "nukadoko.scenario.steps", "Name", "name", "arg0", "a b", "é"].freeze

  def check(&) = Hegel.test(test_cases: 200, verbosity: :quiet, &)

  def parameters(tc)
    Array.new(tc.draw(integers(min_value: 0, max_value: 5))) do
      { name: tc.draw(sampled_from(NAMES)), value: tc.draw(sampled_from(["", "1", "default", "B", "b"])),
        **(tc.draw(integers(min_value: 0, max_value: 3)).zero? ? { excluded: true } : {}) }
    end
  end

  def test_the_history_text_does_not_depend_on_the_order_of_the_parameters
    check do |tc|
      listed = parameters(tc)
      shuffled = listed.sort_by { tc.draw(integers(min_value: 0, max_value: 1000)) }
      assert_equal A.parameters_text(listed), A.parameters_text(shuffled)
    end
  end

  def test_an_excluded_parameter_never_joins_the_history
    check do |tc|
      listed = parameters(tc)
      assert_equal A.parameters_text(listed.reject { _1[:excluded] }), A.parameters_text(listed)
    end
  end

  def test_a_name_is_a_version_8_uuid_the_key_and_place_decide
    check do |tc|
      key = tc.draw(sampled_from(["run-1\u0000scn-1\u0000default", "", "é"]))
      places = tc.draw(integers(min_value: 1, max_value: 4))
      names = lambda do
        writer = A::Writer.new("/nonexistent")
        writer.begin(key)
        Array.new(places) { writer.reserve }
      end
      first = names.()
      assert_equal first, names.()
      assert_equal places, first.uniq.size
      first.each { assert_match(/\A\h{8}-\h{4}-8\h{3}-[89ab]\h{3}-\h{12}\z/, _1) }
    end
  end
end
