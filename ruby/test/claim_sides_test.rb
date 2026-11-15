# frozen_string_literal: true

require "nukadoko"

# The plain JSON copy a claim judges, and the reasons a read gives, in the
# TypeScript engine's words.
class ClaimSidesTest < Minitest::Test
  S = Nukadoko::Engine::ClaimSides

  def test_a_copy_holds_numbers_as_javascript_holds_them
    assert_equal({ value: [2, 2.5, "a", nil] }, S.snapshot([2.0, 2.5, :a, nil]))
    assert_equal ["0", "2", "b"], S.snapshot({ "b" => 1, "2" => 2, "0" => 3 })[:value].keys
  end

  def test_a_copy_refuses_what_is_not_plain_json_and_says_where
    assert_equal({ at: ["0"], problem: "is NaN" }, S.snapshot([Float::NAN])[:refused])
    assert_equal({ at: [], problem: "is -Infinity" }, S.snapshot(-Float::INFINITY)[:refused])
    assert_equal "is the integer 9007199254740992, beyond Number.MAX_SAFE_INTEGER", S.snapshot(2**53 + 1)[:refused][:problem]
    assert_equal "is the integer 100000000000000000000, beyond Number.MAX_SAFE_INTEGER", S.snapshot(1e20)[:refused][:problem]
    assert_equal({ at: ["t"], problem: "is a Time" }, S.snapshot({ "t" => Time.now })[:refused])
    loop = []
    loop << loop
    assert_equal "refers back to a value that holds it", S.snapshot(loop)[:refused][:problem]
    deep = (1..300).reduce([]) { |inner, _| [inner] }
    assert_equal({ at: [], problem: "nests deeper than 256 levels", limit: 256 }, S.snapshot(deep)[:refused])
  end

  def test_a_read_names_where_the_walk_stopped
    inputs = S::Inputs.new(observed: { "value" => {} }, args: { "expected" => "x" }, observes: true, from_keys: [],
                           labels: ->(key) { "sentence:#{key}" }, received: [])
    judged = S.judge({ actual: "value.user.name", compare: "equal", expected: "expected" }, inputs)
    assert_equal "observe:value.user.name is undefined, since observe:value has nothing at user", judged[:reason]
    refute judged[:holds]
  end
end
