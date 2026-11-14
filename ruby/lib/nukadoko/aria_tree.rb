# frozen_string_literal: true
# rbs_inline: enabled

# The values an ARIA snapshot reads as (lib/nukadoko/aria_snapshot.rb):
# the YAML items of its text, the nodes of the tree nukadoko took and of
# the tree a docstring states, and the scores the explanation of a misfit
# aligns them with. Nothing here reads a text or judges a fit; the classes
# sit apart from that module so its functions stay module functions of it
# alone.
module Nukadoko
  module Engine
    module AriaSnapshot
      # One scalar of an item: its text after YAML unquoted it, and whether
      # it was written plain, which is when YAML may read it as a number, a
      # boolean, or null.
      Scalar = Data.define(
        :text, #: String
        :plain, #: bool
      )

      # One item of the list: a key alone, a key and its text, or a key and
      # its children. `source` is the item as written, after `- ` and before
      # any comment, for a message.
      Item = Data.define(
        :line, #: Integer
        :source, #: String
        :key, #: Scalar
        :value, #: Scalar?
        :children, #: Array[Item]?
      )

      # A line of the text that holds an item: its number from 1, the
      # column its content starts at, and the content.
      Line = Data.define(
        :number, #: Integer
        :indent, #: Integer
        :content, #: String
      )

      # A text as a docstring states it, and with its white space folded
      # the way a page's text is: either one fits.
      ExpectedText = Data.define(
        :raw, #: String
        :normalized, #: String
      )

      # Why a text is no ARIA snapshot, with the line it found that on.
      class Problem < StandardError; end

      # One node of the snapshot nukadoko took, or one a docstring names.
      # A text node holds `text`; a role node holds the rest. The top of a
      # tree is a node of role `fragment` that holds the list.
      class Node
        attr_reader :kind #: :role | :text
        attr_reader :role #: String
        attr_reader :name #: String
        attr_reader :states #: Hash[String, untyped]
        attr_reader :props #: Hash[String, untyped]
        attr_reader :children #: Array[Node]
        attr_accessor :children_mode #: String?
        attr_reader :text #: untyped
        attr_reader :line #: Integer
        attr_reader :source #: String

        #: (kind: :role | :text, line: Integer, source: String, ?role: String, ?name: String, ?states: Hash[String, untyped], ?props: Hash[String, untyped], ?children: Array[Node], ?children_mode: String?, ?text: untyped) -> void
        def initialize(kind:, line:, source:, role: "", name: "", states: {}, props: {}, children: [], children_mode: nil, text: nil)
          @kind = kind
          @role = role
          @name = name
          @states = states
          @props = props
          @children = children
          @children_mode = children_mode
          @text = text
          @line = line
          @source = source
        end

        #: () -> bool
        def text? = kind == :text
      end

      # How many nodes of an expected tree fit under an actual node, for
      # each pairing, kept so the alignment counts each pair once.
      class Scores
        #: () -> void
        def initialize
          @memo = { false => {}.compare_by_identity, true => {}.compare_by_identity } #: Hash[bool, Hash[Node, Hash[Node, Integer]]]
        end

        # The nodes of `expected`'s tree that fit under `actual`, `expected`
        # itself included (a fragment counts for none): 0 when `actual` is
        # not the node `expected` names.
        #: (Node, Node, bool) -> Integer
        def of(expected, actual, deep)
          by_actual = (@memo.fetch(deep)[expected] ||= {}.compare_by_identity)
          cached = by_actual[actual]
          return cached if cached

          by_actual[actual] = compute(expected, actual, deep)
        end

        # The in-order pairing of expected children with actual children
        # that fits the most expected nodes; of equals, the one that pairs
        # each expected child with the earliest actual child it can.
        #: (Array[Node], Array[Node]) -> [Integer, Hash[Integer, Integer]]
        def aligned(expected, actual)
          best = Array.new(expected.size + 1) { Array.new(actual.size + 1, 0) }
          (expected.size - 1).downto(0) do |i|
            (actual.size - 1).downto(0) do |j|
              paired = of(expected.fetch(i), actual.fetch(j), false)
              best[i][j] = [best[i][j + 1], best[i + 1][j], paired.zero? ? 0 : paired + best[i + 1][j + 1]].max
            end
          end
          pairs = {} #: Hash[Integer, Integer]
          i = 0
          j = 0
          while i < expected.size && j < actual.size
            paired = of(expected.fetch(i), actual.fetch(j), false)
            if paired.positive? && paired + best[i + 1][j + 1] == best[i][j]
              pairs[i] = j
              i += 1
              j += 1
            elsif best[i][j + 1] == best[i][j]
              j += 1
            else
              i += 1
            end
          end
          [best[0][0], pairs]
        end

        private

        #: (Node, Node, bool) -> Integer
        def compute(expected, actual, deep)
          return 0 unless AriaSnapshot.line_fits?(actual, expected)
          return 1 if expected.text?

          own = expected.role == AriaSnapshot::FRAGMENT ? AriaSnapshot.stated_props(expected.props) : 1
          children = actual.children
          contain, deeper = AriaSnapshot.children_reading(expected, deep)
          return own + aligned(expected.children, children).first if contain

          own + expected.children.each_with_index.sum { |child, index| (at = children[index]) ? of(child, at, deeper) : 0 }
        end
      end
    end
  end
end
