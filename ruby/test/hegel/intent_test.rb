# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of the intent file's format as the Ruby engine reads it: a
# table reads back as written, a value reads back as the same value
# whatever it holds, and a cell reads back whatever text it holds.
class IntentPropertiesTest < Minitest::Test
  include Hegel::Syntax::Methods

  I = Nukadoko::Engine::Intent

  def check(&) = Hegel.test(test_cases: 200, verbosity: :quiet, &)

  # A JSON value a cell may hold: text with spaces and pipes, numbers, and
  # arrays of either.
  def draw_scalar(tc)
    case tc.draw(integers(min_value: 0, max_value: 4))
    when 0 then tc.draw(text(alphabet: "ab :|\"[{\\", max_size: 6))
    when 1 then tc.draw(sampled_from(["plan:team", "a b", "x|y", "", "10", "true", "null", '"q"']))
    when 2 then tc.draw(integers(min_value: -5, max_value: 50))
    when 3 then tc.draw(sampled_from([true, false]))
    end
  end

  def draw_value(tc) = tc.draw(sampled_from([true, false])) ? draw_scalar(tc) : Array.new(tc.draw(integers(min_value: 0, max_value: 3))) { draw_scalar(tc) }

  def draw_term(tc)
    "#{tc.draw(sampled_from(%w[x_result.features x_result.seats x_subject.plan x_id]))}#{tc.draw(sampled_from(%w[= != < <= > >=]))}#{I.value_text(draw_value(tc))}"
  end

  # The cells of a row the format reads: tags and terms on a writer's own
  # kind, and a value change, a count change, or none.
  def draw_cells(tc)
    tags = Array.new(tc.draw(integers(min_value: 0, max_value: 2))) { tc.draw(sampled_from(%w[@overage @team @a-b])) }
    conditions = Array.new(tc.draw(integers(min_value: 0, max_value: 2))) { draw_term(tc) }
    filters = Array.new(tc.draw(integers(min_value: 0, max_value: 1))) { draw_term(tc) }
    kind = tc.draw(sampled_from(%w[x_decision x_usage]))
    projection = nil
    before = after = ""
    case tc.draw(integers(min_value: 0, max_value: 2))
    when 1
      one = tc.draw(integers(min_value: 0, max_value: 3))
      other = tc.draw(integers(min_value: 0, max_value: 3))
      before, after = [one.to_s, other.to_s] unless one == other
    when 2
      one = draw_value(tc)
      other = draw_value(tc)
      unless I.same_value?(one, other)
        projection = tc.draw(sampled_from(%w[x_result.features x_result.seats]))
        before = I.value_text(one)
        after = I.value_text(other)
      end
    end
    { target: [*tags, *conditions].join(" "), observation: [kind, *filters, *projection].join(" "), before: before, after: after }
  end

  def test_a_table_reads_back_every_row_it_writes
    check do |tc|
      rows = Array.new(tc.draw(integers(min_value: 0, max_value: 4))) { draw_cells(tc) }
      read = I.parse("Prose before.\n\n#{I.table(rows)}\n\nProse after.\n")
      assert_equal [], read[:problems]
      assert_equal rows, read[:rows].map { _1[:cells] }
      assert_equal (1..rows.size).to_a, read[:rows].map { _1[:row] }
    end
  end

  def test_a_cell_reads_back_whatever_it_holds
    check do |tc|
      cells = Array.new(tc.draw(integers(min_value: 1, max_value: 4))) { tc.draw(text(alphabet: "ab |\\x", max_size: 8)).strip }
      assert_equal cells, I.table_cells("| #{cells.map { _1.gsub("|", "\\|") }.join(" | ")} |")
    end
  end

  def test_a_value_reads_back_as_the_same_value_as_one_term
    check do |tc|
      written = draw_value(tc)
      text = I.value_text(written)
      assert I.same_value?(I.value_of(text), written)
      assert_equal ["x_a=#{text}", "x_b"], I.split_terms("x_a=#{text} x_b")
    end
  end
end
