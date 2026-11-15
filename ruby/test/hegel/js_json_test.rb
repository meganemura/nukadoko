# frozen_string_literal: true

require "hegel"
require "nukadoko"

# JsJson reads JSON text as JavaScript's JSON.parse reads it. The table's
# messages are what Node 24 printed for each text; 80,000 generated texts
# agreed with it when JsJson was written. The properties say that any text
# JSON.generate writes reads back as its value, and that a text cut short
# is refused in the words V8 uses for it.
class JsJsonTest < Minitest::Test
  include Hegel::Syntax::Methods

  J = Nukadoko::JsJson

  V8 = {
    "" => "Unexpected end of JSON input",
    "a" => "Unexpected token 'a', \"a\" is not valid JSON",
    "{" => "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    "[1,]" => "Unexpected token ']', \"[1,]\" is not valid JSON",
    "{\"a\":1" => "Expected ',' or '}' after property value in JSON at position 6 (line 1 column 7)",
    "{\"a\":1,}" => "Expected double-quoted property name in JSON at position 7 (line 1 column 8)",
    "\"abc" => "Unterminated string in JSON at position 4 (line 1 column 5)",
    "\"a\nb\"" => "Bad control character in string literal in JSON at position 2 (line 1 column 3)",
    "\"\\x\"" => "Bad escaped character in JSON at position 2 (line 1 column 3)",
    "\"\\u12g4\"" => "Bad Unicode escape in JSON at position 5 (line 1 column 6)",
    "1." => "Unterminated fractional number in JSON at position 2 (line 1 column 3)",
    "1e" => "Exponent part is missing a number in JSON at position 2 (line 1 column 3)",
    "-" => "No number after minus sign in JSON at position 1 (line 1 column 2)",
    "01" => "Unexpected number in JSON at position 1 (line 1 column 2)",
    "n1t]" => "Unexpected number in JSON at position 1 (line 1 column 2)",
    "1\r2" => "Unexpected non-whitespace character after JSON at position 2 (line 2 column 1)",
    "{\"a\":1\n,\n\"b\" 2}" => "Expected ':' after property name in JSON at position 13 (line 3 column 5)",
    "NaN" => "\"NaN\" is not valid JSON",
    "aaaaaaaaaaaaaaaaaaaaa" => "Unexpected token 'a', \"aaaaaaaaaa\"... is not valid JSON",
    "[1,2,3,4,5,6,7,8,9,10,11,12,13,x,14,15,16,17,18,19,20]" => "Unexpected token 'x', ...\",11,12,13,x,14,15,16\"... is not valid JSON",
    "/* a */ 1" => "Unexpected token '/', \"/* a */ 1\" is not valid JSON"
  }.freeze

  def test_texts_are_refused_in_v8_words
    V8.each do |text, message|
      error = assert_raises(J::Error, text.inspect) { J.parse(text) }
      assert_equal message, error.message, text.inspect
    end
  end

  def check(&) = Hegel.test(test_cases: 300, verbosity: :quiet, &)

  def json_value(tc, depth = 0)
    kind = tc.draw(integers(min_value: 0, max_value: depth > 2 ? 3 : 5))
    case kind
    when 0 then tc.draw(sampled_from([nil, true, false]))
    when 1 then tc.draw(integers(min_value: -10**6, max_value: 10**6))
    when 2 then tc.draw(floats(allow_nan: false, allow_infinity: false))
    when 3 then tc.draw(text(max_size: 8))
    when 4 then Array.new(tc.draw(integers(min_value: 0, max_value: 3))) { json_value(tc, depth + 1) }
    else Array.new(tc.draw(integers(min_value: 0, max_value: 3))) { [tc.draw(text(max_size: 4)), json_value(tc, depth + 1)] }.to_h
    end
  end

  def test_a_generated_text_reads_back_as_its_value
    check do |tc|
      value = json_value(tc)
      assert_equal [JSON.parse(JSON.generate(value))], [J.parse(JSON.generate(value))]
    end
  end

  def test_a_text_cut_short_ends_in_v8_words_for_the_end
    check do |tc|
      value = Array.new(tc.draw(integers(min_value: 1, max_value: 3))) { json_value(tc, 1) }
      text = JSON.generate(value)
      cut = text[0, text.size - 1]
      error = assert_raises(J::Error) { J.parse(cut) }
      assert_equal "Expected ',' or ']' after array element in JSON at position #{cut.encode("UTF-16LE").bytesize / 2} " \
                   "(line 1 column #{cut.encode("UTF-16LE").bytesize / 2 + 1})", error.message
    end
  end
end
