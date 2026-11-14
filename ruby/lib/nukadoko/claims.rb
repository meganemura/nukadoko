# frozen_string_literal: true

# A Then step declares what it compares; the engine judges. The judge returns
# a record of every comparison it made, so a broken claim shows what was read.
module Nukadoko
  module Engine
    module Claims
      COMPARES = %w[equal not-equal contains-text starts-with-text ends-with-text has-item has-same-items has-fields
                    lacks-field fits-text fits-aria-snapshot is-a matches greater-than at-least less-than at-most judged-as].freeze
      IMPLEMENTED = %w[equal not-equal contains-text has-item].freeze

      def self.unknown_compares(node)
        case node
        in Array then node.flat_map { unknown_compares(_1) }
        in Hash
          own = node.key?(:compare) && !COMPARES.include?(node[:compare]) ? [node[:compare]] : []
          own + node.values.flat_map { unknown_compares(_1) }
        else []
        end
      end

      def self.judge(claims, observed, args)
        claims.map { judge_one(_1, observed, args) }
      end

      def self.judge_one(claim, observed, args)
        actual = observed.fetch(claim[:actual].to_s) { observed.fetch(claim[:actual].to_sym) }
        if claim[:each]
          judge_each(claim[:each], actual, args)
        else
          expected = args.fetch(claim[:expected].to_s)
          { actual: actual, compare: claim[:compare], expected: expected, holds: holds?(claim[:compare], actual, expected) }
        end
      end

      def self.judge_each(each, items, args)
        chosen = items.select { |item| each[:where].all? { judge_one(_1, stringify(item), args)[:holds] } }
        results = chosen.flat_map { |item| each[:claims].map { judge_one(_1, stringify(item), args) } }
        { each: results, chosen: chosen.size, holds: !chosen.empty? && results.all? { _1[:holds] } }
      end

      def self.stringify(item) = item.transform_keys(&:to_s)

      def self.holds?(compare, actual, expected)
        case compare
        when "equal" then actual == expected
        when "not-equal" then actual != expected
        when "contains-text" then actual.to_s.include?(expected.to_s)
        when "has-item" then Array(actual).include?(expected)
        else raise NotImplementedError, "compare #{compare} is not in this prototype"
        end
      end
    end
  end
end
