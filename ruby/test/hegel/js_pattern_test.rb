# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of JsPattern, which reads a matches claim's pattern as
# JavaScript's RegExp does: any text is either a pattern or refused with
# V8's reason, never an error of Ruby's own, and a text is matched unit by
# UTF-16 unit, so its length is JavaScript's length. The examples are
# answers node gave for each pattern.
class JsPatternTest < Minitest::Test
  include Hegel::Syntax::Methods

  P = Nukadoko::Engine::JsPattern

  def check(&) = Hegel.test(test_cases: 300, verbosity: :quiet, &)

  PIECES = ["a", "^", "$", ".", "\\s", "\\b", "\\A", "\\k<n>", "(?<n>a)", "(a)", "\\1", "\\2", "[^]", "[]", "[a-c]", "[z-a]", "(?i:a)", "(?i)", "(?=a)", "(?<=a)",
            "*", "+", "?", "{1}", "{2,1}", "{", "}", "]", "(", ")", "|", "\\", "\\u00e9", "\\x4", "\\c", "\\07", "\\8", "😀", "(?#c)", "a*+"].freeze

  def test_any_text_is_a_pattern_or_refused
    check do |tc|
      source = Array.new(tc.draw(integers(min_value: 0, max_value: 6))) { tc.draw(sampled_from(PIECES)) }.join
      begin
        assert_kind_of Regexp, P.compile(source)
      rescue P::Invalid => e
        assert_match %r{\AInvalid regular expression: /}, e.message
      end
    end
  end

  def test_a_text_is_as_long_as_javascript_counts_it
    check do |tc|
      text = Array.new(tc.draw(integers(min_value: 0, max_value: 6))) { tc.draw(sampled_from(["a", "é", "😀", "\u{10F000}", "\n"])) }.join
      assert_equal text.encode("UTF-16LE").bytesize / 2, P.units(text).length
    end
  end

  # [pattern, text, what node's RegExp#test answered or the reason it gave]
  EXAMPLES = [
    ["^b$", "a\nb", false], ["(?m:^b$)", "a\nb", true], ["\\Ab", "Ab", true], ["a\\sb", "a b", true], ["[^]", "\n", true],
    ["[]", "", false], ["(a)|b\\1", "b", true], ["\\1(a)", "a", true], ["a{,2}", "a{,2}", true], ["^.$", "😀", false], ["^..$", "😀", true],
    ["\\u{2}", "uu", true], ["\\c1", "\\c1", true], ["[\\c1]", "\x11", true], ["\\400", " 0", true], ["\\8", "8", true], ["a{2}?", "aa", true],
    ["^a{2}?$", "", false], ["(?<a>x)|(?<a>y)", "y", true], ["(?<a>a)|(?<a>b)\\k<a>", "bb", true], ["\\k<a>", "k<a>", true], ["(?i:é)", "É", true],
    ["(?i)a", "Invalid group"], ["(?<a>x)(?<a>y)", "Duplicate capture group name"], ["(?<=a)*", "Invalid quantifier"], ["x{2,1}", "numbers out of order in {} quantifier"],
    ["\\", "\\ at end of pattern"], ["^*", "Nothing to repeat"], ["a{2}{3}", "Nothing to repeat"], ["[z-a]", "Range out of order in character class"],
    ["(?ii:a)", "Repeated flag in flag group"], ["(?-:a)", "Invalid flag group"], ["(?<a>.)\\k<b>", "Invalid named capture referenced"], ["(?<a>x)\\k", "Invalid named reference"]
  ].freeze

  def test_each_pattern_answers_as_node_did
    EXAMPLES.each do |source, text, answer|
      if answer.nil?
        error = assert_raises(P::Invalid, source) { P.compile(source) }
        assert_equal "Invalid regular expression: /#{source}/: #{text}", error.message
      else
        assert_equal answer, P.compile(source).match?(P.units(text)), "#{source} on #{text.inspect}"
      end
    end
  end
end
