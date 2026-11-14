# frozen_string_literal: true

# A Then step declares what it compares; the engine judges. A claim names the
# actual value (a key the step observed or was given, and an optional `at`
# path into it), a compare, and where the expected value comes from: an args
# key, `{ literal: v }`, or `{ from: key }` for an args key an earlier step
# filled. The judge returns every comparison it made, so a broken claim shows
# what was read.
require "uri"
require_relative "text_fit"

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
        result = compare(claim[:compare], actual, expected)
        { actual: actual, compare: claim[:compare], expected: expected, holds: result[:holds] == true,
          **(result[:reason] ? { reason: result[:reason] } : {}), **(result[:stopped] ? { reason: result[:stopped], unjudged: true } : {}) }
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

      # A pattern that backtracks gets this long before the claim is left unjudged.
      PATTERN_TIMEOUT = 1.0

      # What `is-a` names, as the TypeScript engine lists the kinds.
      VALUE_KINDS = %w[string text number integer boolean list array object null uuid date timestamp url].freeze
      DATE = /\A(\d{4})-(\d{2})-(\d{2})\z/
      # Seconds are required and a leap second refused, as a program's clock
      # never prints 60; the separator and the offset take the spellings
      # RFC 3339 and ISO 8601 allow.
      TIMESTAMP = /\A(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2})(?::?(\d{2}))?)\z/
      UUID = /\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/

      def self.calendar_day?(year, month, day)
        return false if month < 1 || month > 12 || day < 1

        leap = (year % 4).zero? && !(year % 100).zero? || (year % 400).zero?
        day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
      end

      def self.date?(value)
        match = value.is_a?(String) && DATE.match(value)
        !!match && calendar_day?(*match.captures.map(&:to_i))
      end

      def self.timestamp?(value)
        match = value.is_a?(String) && TIMESTAMP.match(value)
        return false unless match && calendar_day?(*match.captures[0, 3].map(&:to_i))

        hour, minute, second = match.captures[3, 3].map(&:to_i)
        offset = match[7].nil? || (match[7].to_i <= 23 && match[8].to_i <= 59)
        hour <= 23 && minute <= 59 && second <= 59 && offset
      end

      # A text a URL parser accepts can still be no URL a program wrote, so
      # the scheme needs "//" and no character a reader cannot see may appear.
      def self.url?(value)
        return false unless value.is_a?(String) && value.match?(%r{\Ahttps?://}i) && !value.match?(/[\s\p{Cc}\p{Cf}]/)

        uri = URI.parse(value)
        %w[http https].include?(uri.scheme&.downcase) && !uri.host.to_s.empty?
      rescue URI::Error
        false
      end

      KIND_TESTS = {
        "string" => ->(v) { v.is_a?(String) }, "text" => ->(v) { v.is_a?(String) },
        "number" => ->(v) { v.is_a?(Numeric) }, "integer" => ->(v) { v.is_a?(Integer) || (v.is_a?(Float) && v.finite? && v == v.floor) },
        "boolean" => ->(v) { [true, false].include?(v) }, "list" => ->(v) { v.is_a?(Array) }, "array" => ->(v) { v.is_a?(Array) },
        "object" => ->(v) { v.is_a?(Hash) }, "null" => ->(v) { v.nil? }, "uuid" => ->(v) { v.is_a?(String) && v.match?(UUID) },
        "date" => method(:date?), "timestamp" => method(:timestamp?), "url" => method(:url?)
      }.freeze

      # The test of the kind `name` names, read trimmed and in any case.
      def self.value_kind(name) = KIND_TESTS[name.strip.downcase]

      def self.json_type(value)
        case value
        when nil then "null"
        when true, false then "boolean"
        when Numeric then "number"
        when String then "string"
        when Array then "array"
        else "object"
        end
      end

      def self.article(type) = %w[array object].include?(type) ? "an #{type}" : "a #{type}"

      # JavaScript's trim, which takes Unicode spaces and a byte order mark.
      def self.blank?(text) = text.match?(/\A[[:space:]\u{feff}]*\z/)

      # Structural equality over JSON values: key order does not count, and
      # 1 equals 1.0, as JSON writes one number.
      def self.deep_equal?(a, b)
        type = json_type(a)
        return false unless type == json_type(b)

        case type
        when "array" then a.size == b.size && a.each_index.all? { deep_equal?(a[_1], b[_1]) }
        when "object"
          left = normal(a)
          right = normal(b)
          left.size == right.size && left.all? { |key, value| right.key?(key) && deep_equal?(value, right[key]) }
        else a == b
        end
      end

      # The same items, each as many times, in any order.
      def self.same_items?(a, b)
        return false unless a.size == b.size

        unmatched = b.dup
        a.all? do |item|
          index = unmatched.index { deep_equal?(item, _1) }
          index && unmatched.delete_at(index)
          !index.nil?
        end
      end

      # The first place `expected` does not fit `actual` under has-fields, or
      # nil: an object fits one that holds each of its fields with a value
      # that fits, an array one of its length whose items fit, and anything
      # else an equal value.
      def self.field_misfit(actual, expected, path = [])
        case json_type(expected)
        when "object"
          return { kind: "differs", path: path, actual: actual, expected: expected } unless json_type(actual) == "object"

          have = normal(actual)
          normal(expected).each do |key, value|
            return { kind: "missing", path: [*path, key], expected: value } unless have.key?(key)

            found = field_misfit(have[key], value, [*path, key])
            return found if found
          end
          nil
        when "array"
          return { kind: "differs", path: path, actual: actual, expected: expected } unless actual.is_a?(Array)
          return { kind: "length", path: path, actual: actual.size, expected: expected.size } unless actual.size == expected.size

          expected.each_index do |index|
            found = field_misfit(actual[index], expected[index], [*path, index.to_s])
            return found if found
          end
          nil
        else deep_equal?(actual, expected) ? nil : { kind: "differs", path: path, actual: actual, expected: expected }
        end
      end

      # The path of the first object with no field, at any depth, or nil.
      def self.fieldless_object(value, path = [])
        type = json_type(value)
        return nil unless %w[object array].include?(type)

        entries = type == "array" ? value.each_with_index.map { |item, index| [index.to_s, item] } : normal(value).to_a
        return path if type == "object" && entries.empty?

        entries.each do |key, item|
          found = fieldless_object(item, [*path, key])
          return found if found
        end
        nil
      end

      # { holds: } or { reason: } when the two sides cannot be compared, or
      # { stopped: } when nothing judged them. A comparison across two JSON
      # types never holds for the reason the claim states, so it breaks with
      # both types named, and so does an expected value every actual holds.
      def self.compare(compare, actual, expected)
        a_type = json_type(actual)
        e_type = json_type(expected)
        case compare
        when "equal", "not-equal"
          return { reason: "#{compare} compares #{article(a_type)} with #{article(e_type)}" } unless a_type == e_type

          same = deep_equal?(actual, expected)
          { holds: compare == "equal" ? same : !same }
        when "contains-text", "starts-with-text", "ends-with-text", "matches"
          return { reason: "#{compare} reads two strings, and compares #{article(a_type)} with #{article(e_type)}" } unless a_type == "string" && e_type == "string"

          if compare != "matches"
            return { reason: "#{compare} has an expected text of only whitespace or nothing, which almost every string holds" } if blank?(expected)

            return { holds: { "contains-text" => :include?, "starts-with-text" => :start_with?, "ends-with-text" => :end_with? }.then { actual.send(_1[compare], expected) } }
          end
          return { reason: "matches has an empty expected value, which every string holds" } if expected.empty?

          pattern = begin
            Regexp.new(expected, timeout: PATTERN_TIMEOUT)
          rescue RegexpError => e
            return { reason: "matches could not build a regular expression: #{e.message}" }
          end
          return { reason: "matches has a pattern that matches the empty string, so every string holds it" } if pattern.match?("") 

          begin
            { holds: pattern.match?(actual) }
          rescue Regexp::TimeoutError
            { stopped: "matches ran for more than #{PATTERN_TIMEOUT} seconds, so nukadoko stopped judging it" }
          end
        when "fits-text"
          return { reason: "fits-text reads two strings, and compares #{article(a_type)} with #{article(e_type)}" } unless a_type == "string" && e_type == "string"
          return { reason: "fits-text has an expected text of only whitespace, ... lines, [..], and [..:name], which almost every text holds" } if TextFit.only_stand_ins?(expected)

          { holds: TextFit.fit(actual, expected)[:fits] }
        when "fits-aria-snapshot"
          return { reason: "fits-aria-snapshot reads two ARIA snapshots as texts, and compares #{article(a_type)} with #{article(e_type)}" } unless a_type == "string" && e_type == "string"

          { stopped: "the Ruby engine does not judge fits-aria-snapshot yet" }
        when "is-a"
          return { reason: "is-a reads the name of a kind as a string, and the expected value is #{article(e_type)}" } unless e_type == "string"

          kind = value_kind(expected) or return { reason: "is-a names one of the kinds #{VALUE_KINDS.join(", ")}, and the expected value is #{JSON.generate(expected)}" }
          { holds: kind.(actual) }
        when "lacks-field"
          return { reason: "lacks-field reads an object, and the actual value is #{article(a_type)}" } unless a_type == "object"
          return { reason: "lacks-field reads the name of a field as a string, and the expected value is #{article(e_type)}" } unless e_type == "string"
          return { reason: "lacks-field has a blank field name, which almost every object lacks" } if blank?(expected)

          { holds: !normal(actual).key?(expected) }
        when "has-item"
          return { reason: "has-item reads an array, and the actual value is #{article(a_type)}" } unless a_type == "array"
          return { reason: "has-item looks for #{article(e_type)}, and no item is one" } if actual.any? && actual.none? { json_type(_1) == e_type }

          { holds: actual.any? { deep_equal?(_1, expected) } }
        when "has-same-items"
          return { reason: "has-same-items compares two arrays, and compares #{article(a_type)} with #{article(e_type)}" } unless a_type == "array" && e_type == "array"

          { holds: same_items?(actual, expected) }
        when "has-fields"
          return { reason: "has-fields compares two objects, and compares #{article(a_type)} with #{article(e_type)}" } unless a_type == "object" && e_type == "object"

          empty = fieldless_object(expected)
          return { reason: "has-fields has an expected object with no field#{" at #{empty.join(".")}" if empty&.any?}, which every object holds" } if empty

          { holds: field_misfit(actual, expected).nil? }
        when "greater-than", "at-least", "less-than", "at-most"
          return { reason: "#{compare} compares two numbers, and compares #{article(a_type)} with #{article(e_type)}" } unless a_type == "number" && e_type == "number"

          { holds: actual.send({ "greater-than" => :>, "at-least" => :>=, "less-than" => :<, "at-most" => :<= }[compare], expected) }
        when "judged-as"
          { stopped: "the Ruby engine does not read judgments yet, so nothing judged this value" }
        end
      end

      def self.holds?(compare, actual, expected) = compare(compare, actual, expected)[:holds] == true
    end
  end
end
