# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of registering the config's parameterTypes: a list of names
# registers exactly when no name is a built-in type's and none repeats, and
# a registered type with no transformer gives the text its regexp matched,
# so a value inside a sentence with no spaces around it reads as written.
class ParameterTypesTest < Minitest::Test
  include Hegel::Syntax::Methods

  E = Nukadoko::Engine

  def check(&) = Hegel.test(test_cases: 200, verbosity: :quiet, &)

  def teardown = E::Pattern.configure([])

  NAMES = %w[priority dueDay word int spare string].freeze

  def test_a_list_registers_exactly_when_no_name_is_taken
    check do |tc|
      names = tc.draw(arrays(sampled_from(NAMES), max_size: 4))
      E::Pattern.configure(names.map { { name: _1, regexp: /x/ } })
      taken = names.any? { E::Pattern::BUILT_IN.include?(_1) } || names.uniq.size != names.size
      assert_equal taken, !E::Pattern.collision.nil?
    end
  ensure
    E::Pattern.configure([])
  end

  DAYS = %w[今日 明日 明後日].freeze

  def test_a_type_with_no_transformer_reads_the_text_it_matched
    E::Pattern.configure([{ name: "dueDay", regexp: /今日|明日|明後日/ }, { name: "priority", regexp: /高|低/, transformer: ->(s) { s == "高" ? "high" : "low" } }])
    pattern = E::Pattern.new("期限{day:dueDay}の優先度{p:priority}")
    check do |tc|
      day = tc.draw(sampled_from(DAYS))
      high = tc.draw(booleans)
      assert_equal({ "day" => day, "p" => high ? "high" : "low" }, pattern.match("期限#{day}の優先度#{high ? "高" : "低"}"))
    end
  end

  def test_a_shape_the_typescript_schema_refuses_is_refused_in_its_words
    {
      [{ name: "a b", regexp: /x/ }] => "parameterTypes.0.name: Invalid string: must match pattern /^[a-zA-Z0-9_-]+$/",
      [{ name: "a", regexp: 5 }] => "parameterTypes.0.regexp: must be a Regexp or a string",
      [{ name: "a", regexp: /x/, transformer: "t" }] => "parameterTypes.0.transformer: must be a function",
      [{ name: "a", regexp: /x/, extra: 1 }] => "unknown key(s): extra",
      [{ regexp: /x/ }] => "parameterTypes.0.name: Invalid input: expected string, received undefined",
      "x" => "parameterTypes: Invalid input: expected array, received string",
    }.each do |types, detail|
      refusal = assert_raises(E::Refusal) { E::ParameterTypes.read(types) }
      assert_equal "config-invalid", refusal.code
      assert_equal "Invalid config at nukadoko.config.rb: #{detail}", refusal.message
    end
  end
end
