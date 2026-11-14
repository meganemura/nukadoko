# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of the pure parts of the engine: the claim views, the schema's
# strip and drop, a pattern's captures, and the verdict of a table row.
class PropertiesTest < Minitest::Test
  include Hegel::Syntax::Methods

  J = Nukadoko::Engine::Claims

  def check(&) = Hegel.test(test_cases: 200, verbosity: :quiet, &)

  def test_a_trailing_newline_never_changes_the_text_or_lines_view
    check do |tc|
      s = tc.draw(text(alphabet: "ab \n\r", max_size: 20))
      assert_equal J.view("text", s), J.view("text", "#{s}\n")
      assert_equal J.view("lines", s), J.view("lines", "#{s}\n")
      assert_equal J.view("text", s), J.view("text", J.view("text", s))
    end
  end

  def test_lines_join_back_to_the_text_view
    check do |tc|
      s = tc.draw(text(alphabet: "ab \n", max_size: 20))
      assert_equal J.view("text", s), J.view("lines", s).join("\n")
    end
  end

  def test_a_comma_list_reads_back_its_items
    check do |tc|
      items = tc.draw(arrays(text(alphabet: "abc", min_size: 1, max_size: 5), min_size: 1, max_size: 6))
      spaced = tc.draw(booleans)
      assert_equal items, J.view("comma-list", items.join(spaced ? " , " : ","))
    end
  end

  SCHEMA = Nukadoko::Schema.build do
    number :n, "n"
    string :s, "s", null: true
    object(:o, "o") { strings :tags, "tags" }
  end

  def test_strip_keeps_what_the_schema_declares_and_nothing_else
    check do |tc|
      value = { "n" => tc.draw(integers(min_value: -5, max_value: 5)), "s" => tc.draw(optional(text(max_size: 3))),
                "o" => { "tags" => tc.draw(arrays(text(max_size: 3), max_size: 3)) } }
      extra = tc.draw(hashes(text(alphabet: "xyz", min_size: 1, max_size: 3), integers, max_size: 3))
      inner = tc.draw(hashes(text(alphabet: "xyz", min_size: 1, max_size: 3), integers, max_size: 3))
      returned = value.merge(extra).merge("o" => value["o"].merge(inner))
      assert_empty SCHEMA.problems(returned)
      assert_equal value, SCHEMA.strip(returned)
      assert_equal extra.size + inner.size, SCHEMA.dropped(returned).size
      assert_empty SCHEMA.dropped(SCHEMA.strip(returned))
    end
  end

  def test_a_string_capture_reads_back_what_the_line_quotes
    pattern = Nukadoko::Engine::Pattern.new("a todo titled {title:string} is added")
    check do |tc|
      title = tc.draw(text(alphabet: "ab c-", max_size: 12))
      assert_equal({ "title" => title }, pattern.match(%(a todo titled "#{title}" is added)))
    end
  end

  def test_a_row_fails_when_a_required_cell_does_not_pass_and_is_proven_only_by_a_failing_control
    cell = composite do |tc|
      { role: tc.draw(sampled_from(%w[required control])), outcome: tc.draw(sampled_from(%w[pass fail broke flaky])),
        runs: tc.draw(integers(min_value: 1, max_value: 2)) }
    end
    check do |tc|
      cells = tc.draw(arrays(cell, max_size: 5))
      required = cells.select { _1[:role] == "required" }
      failed = required.empty? || required.any? { _1[:outcome] != "pass" }
      proven = cells.any? { _1[:role] == "control" && _1[:outcome] == "fail" && _1[:runs] >= 2 }
      assert_equal(failed ? "failed" : proven ? "proven" : "held", Nukadoko::Engine::Table.verdict(cells))
    end
  end
  O = Nukadoko::Engine::Order
  Item = Struct.new(:uri, :line)

  # A shuffled order is the whole selection sorted by its own keys, so a part
  # of it runs in the order the whole gave it, and each file stays together.
  def test_a_shuffled_part_runs_in_the_order_the_whole_gave_it
    check do |tc|
      seed = tc.draw(integers(min_value: 0, max_value: O::MAX_SEED))
      uris = tc.draw(arrays(text(alphabet: "abc/", min_size: 1, max_size: 4), min_size: 1, max_size: 4)).uniq
      all = uris.flat_map { |uri| tc.draw(arrays(integers(min_value: 1, max_value: 40), min_size: 1, max_size: 4)).uniq.map { Item.new(uri, _1) } }
      part = all.select { tc.draw(booleans) }
      order = { kind: "shuffled", seed: seed }
      whole = O.arrange(all, order)
      assert_equal all.sort_by { [_1.uri, _1.line] }, whole.sort_by { [_1.uri, _1.line] }
      assert_equal whole & part, O.arrange(part, order)
      assert_equal whole.map(&:uri).uniq, whole.chunk_while { _1.uri == _2.uri }.map { _1.first.uri }
    end
  end
end
