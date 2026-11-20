# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of the compat door's DataTable and hook tags: a table read
# any way keeps every cell it was given, and a hook's tag reads the same
# as cucumber-ruby's for a scenario's tags.
class CompatPropertiesTest < Minitest::Test
  include Hegel::Syntax::Methods

  T = Nukadoko::Compat::DataTable
  Hook = Nukadoko::Compat::Hook

  def check(&) = Hegel.test(test_cases: 300, verbosity: :quiet, &)

  def table(tc)
    width = tc.draw(integers(min_value: 1, max_value: 4))
    Array.new(tc.draw(integers(min_value: 1, max_value: 5))) { Array.new(width) { tc.draw(text(alphabet: "ab1 ", max_size: 3)) } }
  end

  def test_a_table_transposed_twice_is_the_table
    check { |tc| raw = table(tc); assert_equal T.new(raw), T.new(raw).transpose.transpose }
  end

  def test_hashes_give_one_row_each_keyed_by_the_header
    check do |tc|
      raw = table(tc)
      hashes = T.new(raw).hashes
      assert_equal raw.size - 1, hashes.size
      # A repeated header keeps its last column, as a Hash does.
      hashes.zip(raw.drop(1)).each { |hash, row| assert_equal raw.first.zip(row).to_h, hash }
    end
  end

  def test_rows_hash_reads_a_two_column_table_and_refuses_any_other
    check do |tc|
      raw = table(tc)
      if raw.first.size == 2
        assert_equal raw.to_h { [_1[0], _1[1]] }, T.new(raw).rows_hash
      else
        assert_raises(ArgumentError) { T.new(raw).rows_hash }
      end
    end
  end

  def test_a_tag_and_its_negation_never_both_select_a_scenario
    check do |tc|
      tag = "@#{tc.draw(sampled_from(%w[a b c]))}"
      tags = tc.draw(arrays(sampled_from(%w[@a @b @c]), max_size: 3))
      hook = ->(expression) { Hook.new(type: :before, tags: [expression], name: nil, block: proc {}, file: "x", line: 1) }
      assert_equal tags.include?(tag), Nukadoko::Compat.applies?(hook.(tag), tags)
      refute_equal Nukadoko::Compat.applies?(hook.(tag), tags), Nukadoko::Compat.applies?(hook.("not #{tag}"), tags)
    end
  end
end
