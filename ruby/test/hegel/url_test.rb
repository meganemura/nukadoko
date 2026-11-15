# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of the url kind of is-a, which reads a text as the WHATWG URL
# parser the TypeScript engine uses does: it answers for any text without
# raising, and a host it takes stays taken whatever path, query, or
# fragment follows, since a browser takes any text there.
class UrlTest < Minitest::Test
  include Hegel::Syntax::Methods

  C = Nukadoko::Engine::Claims

  def check(&) = Hegel.test(test_cases: 300, verbosity: :quiet, &)

  PIECES = ["a", "0", "9", "x", "-", "_", ".", ":", "@", "[", "]", "%", "%41", "%ff", "%e3%81%82", "xn--", "0x", "例", "ａ", "☃", "/", "?", "#", "\\", "{", "|"].freeze
  HOSTS = ["example.com", "例え.jp", "[::1]", "127.0.0.1", "0x7f.1", "xn--r8jz45g.例え", "a..b"].freeze
  TAILS = ["/", "?", "#", "/a{b}", "#c|d", "/パス", "?q=%zz", "\\x", "/;=~!$&'()*+,"].freeze

  def test_answers_for_any_text
    check do |tc|
      text = "#{tc.draw(sampled_from(%w[http:// https:// HTTP:// http:///]))}#{Array.new(tc.draw(integers(min_value: 0, max_value: 8))) { tc.draw(sampled_from(PIECES)) }.join}"
      assert_includes [true, false], C.url?(text), text
    end
  end

  def test_a_tail_never_changes_a_host_it_takes
    check do |tc|
      base = "http://#{tc.draw(sampled_from(HOSTS))}"
      tail = Array.new(tc.draw(integers(min_value: 1, max_value: 4))) { tc.draw(sampled_from(TAILS)) }.join
      assert C.url?(base), base
      assert C.url?("#{base}#{tail}"), "#{base}#{tail}"
    end
  end
end
