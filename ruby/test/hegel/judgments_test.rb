# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of the judgment records: a value's digest does not depend on
# the order its keys were written in, a judgment file reads back as the
# entries it was written from, and recording the same judgment twice keeps
# one entry.
class JudgmentsTest < Minitest::Test
  include Hegel::Syntax::Methods

  J = Nukadoko::Engine::Judgments

  def check(&) = Hegel.test(test_cases: 200, verbosity: :quiet, &)

  KEYS = %w[a b name z_last 1 é].freeze
  LEAVES = [nil, true, false, 0, 12, -3, 1.5, "", "text", "a \"quoted\" line"].freeze

  # A JSON value, its objects with keys in the order the draws gave them.
  def value(tc, depth)
    case tc.draw(integers(min_value: 0, max_value: depth.positive? ? 2 : 0))
    when 0 then tc.draw(sampled_from(LEAVES))
    when 1 then Array.new(tc.draw(integers(min_value: 0, max_value: 3))) { value(tc, depth - 1) }
    else
      keys = KEYS.select { tc.draw(integers(min_value: 0, max_value: 1)) == 1 }
      keys.to_h { [_1, value(tc, depth - 1)] }
    end
  end

  # The same value with each object's keys in reverse order.
  def reversed(value)
    case value
    when Array then value.map { reversed(_1) }
    when Hash then value.to_a.reverse.to_h { |key, item| [key, reversed(item)] }
    else value
    end
  end

  def entry(tc)
    { criterion: tc.draw(sampled_from(["a greeting", "B cart", "a greeting"])), then: tc.draw(sampled_from(["the text reads as \"kind\"", "the total reads as \"small\""])),
      claim: tc.draw(integers(min_value: 0, max_value: 2)), quality: "\"kind\"", value_digest: "sha256:#{tc.draw(sampled_from(%w[aa bb cc]))}",
      value: value(tc, 2), verdict: tc.draw(sampled_from(%w[meets misses])), because: "It reads so.", by: "ann", run_id: "run-1",
      commit: nil, at: tc.draw(sampled_from(["2026-11-14T00:00:00.000Z", "2026-11-14T00:00:01.000Z"])) }
  end

  def test_the_digest_does_not_depend_on_key_order
    check do |tc|
      read = value(tc, 3)
      assert_equal J.value_digest(read), J.value_digest(reversed(read))
      assert_equal J.value_digest(read), J.value_digest(JSON.parse(JSON.generate(read)))
    end
  end

  def test_a_judgment_file_reads_back_as_its_entries
    check do |tc|
      entries = Array.new(tc.draw(integers(min_value: 0, max_value: 4))) { entry(tc) }
      read = J.parse_file(J.file_text(entries))
      assert_nil read[:problem]
      assert_equal entries.map { JSON.parse(JSON.generate(_1)) }.sort_by(&:to_s), read[:entries].map { JSON.parse(JSON.generate(_1)) }.sort_by(&:to_s)
    end
  end

  def test_recording_the_same_judgment_twice_keeps_one_entry
    check do |tc|
      entries = Array.new(tc.draw(integers(min_value: 0, max_value: 4))) { entry(tc) }
      added = entry(tc)
      once = J.add(entries, added)
      assert_equal once, J.add(once, added)
      assert_equal 1, once.count { _1 == added }
    end
  end
end
