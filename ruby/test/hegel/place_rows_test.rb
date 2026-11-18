# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of run.json's flags as the Ruby engine reads them from a
# run's own scenarios and table: each row's counts add up to its criteria,
# and the rows do not depend on the order the executions are listed in.
class PlaceRowsPropertiesTest < Minitest::Test
  include Hegel::Syntax::Methods

  P = Nukadoko::Engine::PlaceRows

  def check(&) = Hegel.test(test_cases: 200, verbosity: :quiet, &)

  def draw_run(tc)
    rows = Array.new(tc.draw(integers(min_value: 1, max_value: 4))) do |index|
      { feature: "features/a.feature", line: index + 1, name: "s#{index}", verdict: tc.draw(sampled_from(%w[held proven failed unproven])),
        cells: %w[on off].map { { world: "head", environment: _1, role: tc.draw(sampled_from(%w[required control])), outcome: "pass" } } }
    end
    scenarios = Array.new(tc.draw(integers(min_value: 0, max_value: 6))) do |index|
      flags = Array.new(tc.draw(integers(min_value: 0, max_value: 2))) do
        { "kind" => "flag", "name" => tc.draw(sampled_from(%w[a b])), "side" => tc.draw(sampled_from(%w[on off])), "count" => 1,
          "gates" => [tc.draw(sampled_from(["actor", "boolean", nil]))] }
      end
      { scenario_record_id: "scn-#{index}", feature: "features/a.feature", line: tc.draw(integers(min_value: 1, max_value: rows.size)),
        environment: tc.draw(sampled_from(%w[on off])), steps: [{ path: { requests: [], entries: flags } }] }
    end
    [scenarios, rows]
  end

  def test_a_flag_rows_counts_add_up_to_its_criteria
    check do |tc|
      scenarios, rows = draw_run(tc)
      P.flag_rows(scenarios, rows).each { assert_equal _1[:criteria].size, _1[:counts].values.sum }
    end
  end

  def test_flag_rows_do_not_depend_on_the_order_of_the_executions
    check do |tc|
      scenarios, rows = draw_run(tc)
      sorted = ->(found) { found.map { |row| row.merge(criteria: row[:criteria].map { |c| c.merge(cells: c[:cells].map { _1.merge(gates: _1[:gates].sort_by(&:to_s)) }) }) } }
      assert_equal sorted.(P.flag_rows(scenarios, rows)), sorted.(P.flag_rows(scenarios.reverse, rows))
    end
  end
end
