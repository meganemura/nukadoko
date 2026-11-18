# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of a program's lists as the Ruby engine reads them: a list is
# a set, so printing an entry twice or in another order reads the same
# entries, and one line that is not an entry of its kind leaves the whole
# list unread.
class ListsPropertiesTest < Minitest::Test
  include Hegel::Syntax::Methods

  L = Nukadoko::Engine::Events::Lists

  def check(&) = Hegel.test(test_cases: 200, verbosity: :quiet, &)

  def draw_routes(tc)
    Array.new(tc.draw(integers(min_value: 0, max_value: 6))) do
      { "method" => tc.draw(sampled_from(%w[GET POST])), "route" => tc.draw(sampled_from(%w[/a /b /c])),
        **(tc.draw(booleans) ? { "handler" => tc.draw(sampled_from(%w[a#x b#y])) } : {}) }
    end
  end

  def output(lines) = lines.map { "#{JSON.generate(_1)}\n" }.join

  def test_a_routes_list_reads_the_same_whatever_the_order_and_repeats_of_its_lines
    check do |tc|
      lines = draw_routes(tc)
      read = L.parse("routes", output(lines))
      shuffled = L.parse("routes", output(lines.reverse + lines))
      sorted = ->(found) { found[:entries].sort_by { [_1[:method], _1[:route]] } }
      assert_equal sorted.(read), sorted.(shuffled)
      assert_equal lines.map { [_1["method"], _1["route"]] }.uniq.size, read[:entries].size
    end
  end

  def test_one_line_that_is_not_an_entry_leaves_the_list_unread
    check do |tc|
      lines = draw_routes(tc).map { JSON.generate(_1) }
      bad = tc.draw(sampled_from(['{"method":"get","route":"/a"}', '{"route":"/a"}', "not json", '{"method":"GET","route":"/a","x":1}']))
      at = tc.draw(integers(min_value: 0, max_value: lines.size))
      read = L.parse("routes", lines.insert(at, bad).join("\n"))
      assert read.key?(:problem)
      assert_match(/\Aline #{at + 1}/, read[:problem])
    end
  end
end
