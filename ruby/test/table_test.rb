# frozen_string_literal: true

require "nukadoko"

class TableTest < Minitest::Test
  T = Nukadoko::Engine::Table

  def cell(role, outcome, runs = 1) = { role: role, outcome: outcome, runs: runs }

  def test_a_row_is_proven_only_by_a_control_that_failed_in_every_proof_run
    assert_equal "proven", T.verdict([cell("required", "pass"), cell("control", "fail", 2)])
    assert_equal "held", T.verdict([cell("required", "pass"), cell("control", "fail", 1)])
    assert_equal "held", T.verdict([cell("required", "pass"), cell("control", "broke", 2)])
    assert_equal "held", T.verdict([cell("required", "pass", 2), cell("control", "pass", 2)])
    assert_equal "held", T.verdict([cell("required", "pass", 3)])
  end

  def test_role_reads_with_and_without_tags
    conditions = { "flag" => true, "mode" => "fast" }
    assert_equal "required", T.role(["@with:flag", "@with:mode=fast"], conditions)
    assert_equal "control", T.role(["@with:mode=slow"], conditions)
    assert_equal "control", T.role(["@without:flag"], conditions)
    assert_equal "required", T.role(["@without:other"], conditions)
  end

  def test_cell_names_flaky_runs_and_the_line_of_a_failure
    assert_equal({ outcome: "flaky", line: 9, runs: 2 }, T.cell([[:pass], [:fail, 9, 0]]))
    assert_equal({ outcome: "fail", line: 9, runs: 2 }, T.cell([[:fail, 9, 0], [:fail, 9, 0]]))
    assert_equal({ outcome: "pass", runs: 1 }, T.cell([[:pass]]))
  end
end
