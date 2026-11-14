# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of the ARIA snapshot reader and matcher fits-aria-snapshot is
# judged with: a tree the browser printed fits itself as a docstring, a
# docstring that leaves out nodes still fits, and the explanation of a
# misfit exists exactly when the two trees do not fit.
class AriaSnapshotTest < Minitest::Test
  include Hegel::Syntax::Methods

  A = Nukadoko::Engine::AriaSnapshot

  def check(&) = Hegel.test(test_cases: 200, verbosity: :quiet, &)

  ROLES = %w[heading button list listitem link checkbox region].freeze
  NAMES = ["", "Score", "Room 7", "a: b", "x [y]"].freeze
  STATES = ["", " [checked]", " [disabled]", " [level=2]", " [expanded]"].freeze
  TEXTS = %w[one two Hello].freeze

  # A tree as nested [key, children] pairs, a text as a String.
  def tree(tc, depth)
    count = tc.draw(integers(min_value: 1, max_value: 3))
    Array.new(count) do
      next tc.draw(sampled_from(TEXTS)) if tc.draw(integers(min_value: 0, max_value: 5)).zero?

      name = tc.draw(sampled_from(NAMES))
      key = "#{tc.draw(sampled_from(ROLES))}#{name.empty? ? "" : " #{JSON.generate(name)}"}#{tc.draw(sampled_from(STATES))}"
      children = depth.positive? && tc.draw(integers(min_value: 0, max_value: 1)) == 1 ? tree(tc, depth - 1) : []
      [key, children]
    end
  end

  # The text the browser prints for a tree: a key in single quotes when it
  # holds a colon, children under a key that ends in one.
  def print(nodes, indent = 0)
    nodes.flat_map do |node|
      pad = " " * indent
      next ["#{pad}- text: #{node}"] if node.is_a?(String)

      key, children = node
      key = "'#{key}'" if key.include?(":")
      children.empty? ? ["#{pad}- #{key}"] : ["#{pad}- #{key}:", *print(children, indent + 2)]
    end
  end

  # The tree with each node kept or dropped as `keep` says, in order.
  def pruned(nodes, keep)
    nodes.filter_map do |node|
      next nil unless keep.()
      next node if node.is_a?(String)

      [node[0], pruned(node[1], keep)]
    end
  end

  def test_a_printed_tree_fits_itself
    check do |tc|
      text = print(tree(tc, 2)).join("\n")
      assert_equal({ fits: true }, A.judge(text, text))
      assert_nil A.difference(text, text)
      assert_nil A.excerpt(text, text)
    end
  end

  def test_a_tree_with_nodes_left_out_still_fits
    check do |tc|
      nodes = tree(tc, 2)
      fewer = pruned(nodes, -> { tc.draw(integers(min_value: 0, max_value: 2)).positive? })
      next if fewer.empty?

      assert_equal({ fits: true }, A.judge(print(nodes).join("\n"), print(fewer).join("\n")))
    end
  end

  def test_a_misfit_is_explained_exactly_when_the_trees_do_not_fit
    check do |tc|
      actual = print(tree(tc, 2)).join("\n")
      expected = print(tree(tc, 1)).join("\n")
      judged = A.judge(actual, expected)
      next unless judged.key?(:fits)

      assert_equal judged[:fits], A.difference(actual, expected).nil?
    end
  end
end
