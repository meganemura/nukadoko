# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of the failures underneath an execution: a tag reads back as
# the failure it names, the status groups count every failed response
# once and point at the first, and a scenario whose tags name every
# failure it saw stays a pass.
class UnderneathPropertiesTest < Minitest::Test
  include Hegel::Syntax::Methods

  U = Nukadoko::Engine::Underneath

  def check(&) = Hegel.test(test_cases: 200, verbosity: :quiet, &)

  def draw_value(tc, kind)
    return tc.draw(integers(min_value: 500, max_value: 599)).to_s if kind == "status"

    tc.draw(text(alphabet: "ABCabc_.:-9", min_size: 1, max_size: 8))
  end

  def draw_http(tc)
    Array.new(tc.draw(integers(min_value: 0, max_value: 8))) do
      next nil if tc.draw(integers(min_value: 0, max_value: 5)).zero?

      { method: "POST", url: "http://localhost:1/#{tc.draw(sampled_from(%w[a b c]))}", via: "request",
        status: tc.draw(sampled_from([200, 404, 500, 503, 503, 599])) }
    end
  end

  def test_a_tag_reads_back_as_the_failure_it_names
    check do |tc|
      kind = tc.draw(sampled_from(U::KIND_ORDER))
      value = draw_value(tc, kind)
      assert_equal [kind, value], U.read_tag(U.tag_text(kind, value))
    end
  end

  def test_each_failed_response_is_counted_once_and_its_first_named
    check do |tc|
      http = draw_http(tc)
      groups = U.status_groups(http)
      failed = http.compact.select { (500..599).cover?(_1[:status]) }
      assert_equal failed.size, groups.sum { _1[:count] }
      groups.each do |group|
        first = http.index { _1 && _1[:status] == group[:status] }
        assert_equal first, group[:first][:http_line]
      end
    end
  end

  def test_a_scenario_whose_tags_name_every_failure_stays_a_pass
    check do |tc|
      steps = Array.new(tc.draw(integers(min_value: 1, max_value: 3))) do |index|
        http = draw_http(tc)
        errors = Array.new(tc.draw(integers(min_value: 0, max_value: 2))) do
          { "kind" => "error", "class" => draw_value(tc, "error"), "handled" => tc.draw(sampled_from([true, false])), "count" => 1 }
        end
        { line: index + 2, underneath: U.of_record(nil, http, nil, nil), path: { entries: errors } }
      end
      execution = { line: 1, status: "passed", steps: steps }
      found = U.failures(execution)
      named = { **execution, expects: found.filter_map { _1[:value] && U.tag_text(_1[:kind], _1[:value]) } }
      assert_nil U.demoting(named)
      if found.any?
        refute_nil U.demoting(execution)
        assert_equal found.first[:line], U.demoting(execution)[:line]
      end
    end
  end
end
