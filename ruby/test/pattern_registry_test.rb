# frozen_string_literal: true

require "nukadoko"

# What the JavaScript cucumber-expressions package gives for each line, so a
# line binds and reads in the Ruby engine as it does in the TypeScript one.
# NaN stands for the NaN parseFloat gives; a double past 2**53 is the one
# JavaScript's Number rounds to.
class PatternRegistryTest < Minitest::Test
  NB = " "
  CASES = [
    ["{word} x", "a#{NB}b x", nil],
    ["{word} x", "a　 x", nil],
    ["{float} {int}", "- 0", [:nan, 0]],
    ["{float}", "1.", nil],
    ["{float}", ".5", [0.5]],
    ["{float}", "+1", [1]],
    ["{float}", "1E3", [1000]],
    ["{double}", "-1.5E-3", [-0.0015]],
    ["{bigdecimal}", "01.50", ["01.50"]],
    ["{int}", "007", [7]],
    ["{int}", "99999999999999999999", [100_000_000_000_000_000_000.0]],
    ["{long}", "-9007199254740993", [-9_007_199_254_740_992.0]],
    ["{}", "a\rb", nil],
    ["{string}", "\"a\\\"b\"", ["a\"b"]],
  ].freeze

  def test_each_line_reads_as_the_javascript_package_reads_it
    CASES.each do |source, text, values|
      expression = Cucumber::CucumberExpressions::CucumberExpression.new(source, Nukadoko::Engine::Pattern.registry)
      read = expression.match(text)&.map { _1.value(nil) }
      read = read&.map { _1.is_a?(Float) && _1.nan? ? :nan : _1 }
      values.nil? ? assert_nil(read, "#{source} on #{text.inspect}") : assert_equal(values, read, "#{source} on #{text.inspect}")
    end
  end

  def test_a_named_capture_reads_as_its_type
    assert_equal({ "n" => 0.5, "w" => "a" }, Nukadoko::Engine::Pattern.new("{n:float} and {w:word}").match(".5 and a"))
  end
end
