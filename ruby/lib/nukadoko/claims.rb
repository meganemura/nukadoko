# frozen_string_literal: true

# A Then step declares what it compares; the engine judges. A claim names the
# actual value (a key the step observed or was given, and an optional `at`
# path into it), a compare, and where the expected value comes from: an args
# key, `{ literal: v }`, or `{ from: key }` for an args key an earlier step
# filled. The judge returns every comparison it made, so a broken claim shows
# what was read.
module Nukadoko
  module Engine
    module Claims
      COMPARES = %w[equal not-equal contains-text starts-with-text ends-with-text has-item has-same-items has-fields
                    lacks-field fits-text fits-aria-snapshot is-a matches greater-than at-least less-than at-most judged-as].freeze

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
        actual = dig(view(claim[:view], read(observed, claim[:actual])), claim[:at])
        return judge_each(claim[:each], actual, args) if claim[:each]

        expected = expected_value(claim, args)
        { actual: actual, compare: claim[:compare], expected: expected, holds: holds?(claim[:compare], actual, expected) }
      end

      def self.judge_each(each, items, args)
        chosen = Array(items).select { |item| each[:where].all? { judge_one(_1, item, args)[:holds] } }
        results = chosen.flat_map { |item| each[:claims].map { judge_one(_1, item, args) } }
        { each: results, chosen: chosen.size, holds: !chosen.empty? && results.all? { _1[:holds] } }
      end

      def self.expected_value(claim, args)
        value =
          case claim[:expected]
          in String => key then read(args, key)
          in { literal: literal } then literal
          in { from: String => key } then read(args, key)
          end
        claim[:expected_view] == "json" ? JSON.parse(value) : value
      end

      VIEWS = %w[text lines comma-list json].freeze

      # A view reads a string as something else before `at` walks into it.
      def self.view(name, value)
        return value unless name
        raise ArgumentError, "view #{name} reads a string, and the value is #{value.inspect}" unless value.is_a?(String)

        case name
        when "text" then value.rstrip
        when "lines" then value.rstrip.empty? ? [] : value.rstrip.split(/\r?\n/)
        when "comma-list" then value.strip.empty? ? [] : value.strip.split(",").map(&:strip)
        when "json" then JSON.parse(value)
        else raise ArgumentError, "unknown view #{name}"
        end
      end

      def self.read(hash, key)
        hash = hash.transform_keys(&:to_s) if hash.is_a?(Hash)
        hash.fetch(key.to_s)
      end

      def self.dig(value, path)
        return value unless path

        path.to_s.split(".").reduce(value) { |v, part| v.is_a?(Array) ? v[Integer(part)] : read(v, part) }
      end

      def self.same?(a, b) = normal(a) == normal(b)

      def self.normal(value)
        case value
        when Hash then value.to_h { |k, v| [k.to_s, normal(v)] }
        when Array then value.map { normal(_1) }
        when Symbol then value.to_s
        else value
        end
      end

      def self.holds?(compare, actual, expected)
        case compare
        when "equal" then same?(actual, expected)
        when "not-equal" then !same?(actual, expected)
        when "contains-text" then actual.to_s.include?(expected.to_s)
        when "starts-with-text" then actual.to_s.start_with?(expected.to_s)
        when "ends-with-text" then actual.to_s.end_with?(expected.to_s)
        when "has-item" then Array(actual).any? { same?(_1, expected) }
        when "has-same-items" then Array(actual).map { normal(_1) }.tally == Array(expected).map { normal(_1) }.tally
        when "greater-than" then actual.is_a?(Numeric) && actual > expected
        when "at-least" then actual.is_a?(Numeric) && actual >= expected
        when "less-than" then actual.is_a?(Numeric) && actual < expected
        when "at-most" then actual.is_a?(Numeric) && actual <= expected
        when "matches" then Regexp.new(expected.to_s).match?(actual.to_s)
        else raise NotImplementedError, "the Ruby engine cannot judge #{compare} yet"
        end
      end
    end
  end
end
