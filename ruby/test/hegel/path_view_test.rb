# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of run.json's paths as the Ruby engine compares two
# environments' executions: the counts add up to what was compared, two
# sides that did the same thing read as the same, and which side is `a`
# follows the condition, not the order the environments are declared in.
class PathViewPropertiesTest < Minitest::Test
  include Hegel::Syntax::Methods

  V = Nukadoko::Engine::PathView

  def check(&) = Hegel.test(test_cases: 200, verbosity: :quiet, &)

  def draw_path(tc)
    entries = Array.new(tc.draw(integers(min_value: 0, max_value: 2))) do |index|
      { "kind" => "db", "table" => "t#{index}", "op" => tc.draw(sampled_from(%w[insert update])), "count" => tc.draw(integers(min_value: 1, max_value: 3)) }
    end
    { requests: [], entries: entries.uniq { [_1["table"], _1["op"]] }, maybe: tc.draw(integers(min_value: 0, max_value: 1)), open: [] }
  end

  # A count a line that may be any line could reach is open on both sides
  # alike, so it reads as the same so far.
  # A run of `rows` criteria in the environments off and on, whose
  # condition `quick` differs, with each step's path drawn per side, or the
  # same on both when `same` is set.
  def draw_doc(tc, same: false)
    rows = Array.new(tc.draw(integers(min_value: 1, max_value: 3))) do |index|
      { feature: "features/a.feature", line: (index + 1) * 10, name: "s#{index}", verdict: "held", change: nil,
        cells: %w[off on].map { { world: "head", environment: _1, role: "required", outcome: "pass" } } }
    end
    scenarios = []
    rows.each do |row|
      paths = Array.new(tc.draw(integers(min_value: 1, max_value: 2))) { draw_path(tc) }
      %w[off on].each do |environment|
        steps = paths.each_with_index.map do |path, index|
          { line: row[:line] + index + 1, text: "step #{index}", record: "steps/x", path: same || environment == "off" ? path : draw_path(tc) }
        end
        scenarios << { scenario_record_id: "scn-#{row[:line]}-#{environment}", feature: row[:feature], line: row[:line], environment: environment, steps: steps }
      end
    end
    environments = [{ name: "off", conditions: { quick: false } }, { name: "on", conditions: { quick: true } }]
    worlds = %w[off on].map { { name: _1, tree: "head", error: nil, events: {} } }
    { scenarios: scenarios, table: { base: nil, rows: rows }, environments: environments, worlds: worlds }
  end

  def test_the_counts_add_up_to_what_was_compared
    check do |tc|
      doc = draw_doc(tc)
      V.compare(doc).each do |comparison|
        assert_equal comparison[:criteria].size + comparison[:not_compared].size, comparison[:counts].values.sum
        assert_equal doc[:table][:rows].size, comparison[:criteria].size
      end
    end
  end

  def test_two_sides_that_did_the_same_read_as_the_same
    check do |tc|
      comparisons = V.compare(draw_doc(tc, same: true))
      assert_equal 1, comparisons.size
      assert(comparisons.first[:criteria].all? { %w[same same_so_far].include?(_1[:result]) })
    end
  end

  def test_the_side_that_holds_false_is_a_whatever_the_order
    check do |tc|
      doc = draw_doc(tc)
      assert_equal V.compare(doc), V.compare(doc.merge(environments: doc[:environments].reverse))
    end
  end
end
