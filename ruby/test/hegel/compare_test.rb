# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of the compares a claim is judged with: fits-text's line
# matcher, the item and field matchers, and that two JSON types never
# compare, so a claim breaks with a reason rather than holds by accident.
class CompareTest < Minitest::Test
  include Hegel::Syntax::Methods

  J = Nukadoko::Engine::Claims
  T = Nukadoko::Engine::TextFit
  L = Nukadoko::Engine::ClaimLine

  def check(&) = Hegel.test(test_cases: 200, verbosity: :quiet, &)

  def lines(tc) = tc.draw(arrays(text(alphabet: "ab x:", min_size: 1, max_size: 6), min_size: 1, max_size: 6))

  def test_a_text_without_stand_ins_fits_itself_and_its_line_ending
    check do |tc|
      have = lines(tc).join("\n")
      assert T.fit(have, have)[:fits]
      assert T.fit("#{have}\n", have)[:fits]
      assert T.fit(have.gsub("\n", "\r\n"), have)[:fits]
    end
  end

  def test_stand_ins_fit_what_they_stand_for
    check do |tc|
      have = lines(tc)
      line = tc.draw(integers(min_value: 0, max_value: have.size - 1))
      cut = tc.draw(integers(min_value: 0, max_value: have[line].size))
      from = tc.draw(integers(min_value: 0, max_value: have.size))
      to = tc.draw(integers(min_value: from, max_value: have.size))
      in_line = have.dup.tap { _1[line] = "#{have[line][0, cut]}[..]" }
      assert T.fit(have.join("\n"), in_line.join("\n"))[:fits]
      run = [*have[0...from], "...", *have[to..]]
      assert T.fit(have.join("\n"), run.join("\n"))[:fits]
    end
  end

  def test_one_more_actual_line_never_fits_and_the_line_says_where
    check do |tc|
      have = lines(tc)
      extra = tc.draw(text(alphabet: "ab", min_size: 1, max_size: 3))
      fit = T.fit([*have, extra].join("\n"), have.join("\n"))
      refute fit[:fits]
      assert_equal have.size + 1, fit[:at]
      assert_equal "every expected line fits, and actual line #{have.size + 1} is left over: actual #{JSON.generate(extra)}",
                   L.fits_difference([*have, extra].join("\n"), have.join("\n"))
    end
  end

  def test_a_named_stand_in_reads_one_text
    assert T.fit("id 7\nagain 7", "id [..:n]\nagain [..:n]")[:fits]
    fit = T.fit("id 7\nagain 8", "id [..:n]\nagain [..:n]")
    assert_equal %w[7 8], fit[:readings].map { _1[:text] }
    refute T.fit("a 1 b 1", "a [..:x] b [..:y]")[:fits]
  end

  def test_same_items_holds_in_any_order_and_counts_each_item
    check do |tc|
      items = tc.draw(arrays(integers(min_value: 0, max_value: 3), max_size: 6))
      assert J.same_items?(items, items.shuffle(random: Random.new(tc.draw(integers(min_value: 0, max_value: 99)))))
      refute J.same_items?(items, [*items, items.first || 0])
    end
  end

  def test_has_fields_holds_for_any_subset_of_the_fields
    check do |tc|
      object = tc.draw(hashes(text(alphabet: "abc", min_size: 1, max_size: 2), integers(min_value: 0, max_value: 3), min_size: 1, max_size: 4))
      keys = object.keys.select { tc.draw(booleans) }
      keys = [object.keys.first] if keys.empty?
      assert J.compare("has-fields", object, object.slice(*keys))[:holds]
      missing = "#{object.keys.max}z"
      refute J.compare("has-fields", object, { missing => 1 })[:holds]
      assert_equal "first field that does not fit at #{missing}: actual nothing, expected 1", L.fields_difference(object, { missing => 1 })
    end
  end

  def test_two_json_types_never_compare
    values = [nil, true, 1, "1", [1], { "a" => 1 }]
    values.product(values).each do |a, e|
      next if J.json_type(a) == J.json_type(e)

      assert_equal "equal compares #{J.article(J.json_type(a))} with #{J.article(J.json_type(e))}", J.compare("equal", a, e)[:reason]
    end
  end

  def test_a_value_every_actual_holds_breaks_with_a_reason
    assert_equal "contains-text has an expected text of only whitespace or nothing, which almost every string holds", J.compare("contains-text", "x", " ")[:reason]
    assert_equal "matches has a pattern that matches the empty string, so every string holds it", J.compare("matches", "x", "a*")[:reason]
    assert_equal "has-fields has an expected object with no field at a, which every object holds", J.compare("has-fields", { "a" => {} }, { "a" => {} })[:reason]
    assert_equal "lacks-field has a blank field name, which almost every object lacks", J.compare("lacks-field", {}, " ")[:reason]
    assert_equal "fits-text has an expected text of only whitespace, ... lines, [..], and [..:name], which almost every text holds", J.compare("fits-text", "x", "...\n[..]")[:reason]
  end

  def test_is_a_reads_each_kind
    assert J.compare("is-a", "0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b", "uuid")[:holds]
    assert J.compare("is-a", "2024-02-29", "Date")[:holds]
    refute J.compare("is-a", "2023-02-29", "date")[:holds]
    assert J.compare("is-a", "2026-11-14T10:00:00+09:00", "timestamp")[:holds]
    refute J.compare("is-a", "2026-11-14T10:00:60Z", "timestamp")[:holds]
    assert J.compare("is-a", "https://example.com/a", "url")[:holds]
    refute J.compare("is-a", "http:example.com", "url")[:holds]
    assert J.compare("is-a", 3.0, "integer")[:holds]
    assert_match(/\Ais-a names one of the kinds string, text/, J.compare("is-a", 1, "thing")[:reason])
  end

  def test_lacks_field_reads_a_null_field_as_present
    refute J.compare("lacks-field", { "password" => nil }, "password")[:holds]
    assert_equal 'field "password" is present and holds null', L.present_field_difference({ "password" => nil }, "password")
  end
end
