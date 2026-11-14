# frozen_string_literal: true

require "nukadoko"

class ClaimsTest < Minitest::Test
  J = Nukadoko::Engine::Claims

  def judge(claim, observed, args = {}) = J.judge_one(claim, observed, args)

  def test_view_text_ignores_a_trailing_newline
    assert judge({ actual: "out", view: "text", compare: "equal", expected: "want" }, { out: "a\nb\n" }, { "want" => "a\nb" })[:holds]
  end

  def test_view_lines_then_at_reads_one_line
    assert judge({ actual: "err", view: "lines", at: "1", compare: "equal", expected: { literal: "two" } }, { err: "one\r\ntwo\n" })[:holds]
  end

  def test_view_comma_list_trims_each_item
    assert_equal %w[a b], J.view("comma-list", " a , b ")
    assert_equal [], J.view("comma-list", "  ")
  end

  def test_view_reads_only_a_string
    assert_raises(ArgumentError) { J.view("lines", 3) }
  end

  def test_each_holds_only_when_some_item_is_chosen
    claim = { actual: "items", each: { where: [{ actual: "name", compare: "equal", expected: "name" }], claims: [{ actual: "done", compare: "equal", expected: { literal: true } }] } }
    assert judge(claim, { items: [{ name: "a", done: true }] }, { "name" => "a" })[:holds]
    refute judge(claim, { items: [{ name: "b", done: true }] }, { "name" => "a" })[:holds]
  end

  def test_order_compares_hold_only_for_numbers
    refute J.holds?("at-least", "3", 1)
    assert J.holds?("at-least", 3, 3)
  end
end
