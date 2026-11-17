# frozen_string_literal: true

require "nukadoko"

# Under --base, which judgment a read cites the base already held, and
# which the change brought: the same entry is the base's, and one judged
# again, or one the base never had, is the change's.
class BaseJudgmentsTest < Minitest::Test
  J = Nukadoko::Engine::Judgments

  ENTRY = { criterion: "a visitor is greeted", then: "the greeting reads as \"warm\"", claim: 0, quality: "warm",
            value_digest: "sha256:aa", value: "Hi", verdict: "meets", because: "It welcomes.", by: "ann",
            run_id: "run-1", commit: nil, at: "2026-11-17T00:00:00Z" }.freeze

  def row(entry)
    read = { line: 4, step: ENTRY[:then], claim: 0, environment: "default", quality: "warm", value_from: "x",
             value_digest: ENTRY[:value_digest], measured: "stdout", record: nil, state: "judged",
             judgment: J.cited(entry) }
    { feature: "features/greeting.feature", line: 3, name: ENTRY[:criterion],
      judgment: { state: "judged", reason: "", reads: [read] } }
  end

  def in_base(rows) = rows.map { _1[:judgment][:reads].map { |read| read[:judgment][:in_base] } }

  def test_the_base_holding_the_same_entry_is_the_base_judgment
    assert_equal [[true]], in_base(J.with_base_judgments([row(ENTRY)], ->(_) { [ENTRY] }))
  end

  def test_a_judgment_made_again_or_absent_at_the_base_is_the_change_judgment
    again = ENTRY.merge(at: "2026-11-18T00:00:00Z")
    assert_equal [[false]], in_base(J.with_base_judgments([row(again)], ->(_) { [ENTRY] }))
    assert_equal [[false]], in_base(J.with_base_judgments([row(ENTRY)], ->(_) { [] }))
  end

  def test_an_unread_base_file_leaves_the_reads_unmarked
    assert_equal [[nil]], in_base(J.with_base_judgments([row(ENTRY)], ->(_) {}))
  end
end
