# frozen_string_literal: true
# rbs_inline: enabled

# A Then step declares what it compares; the engine judges. A claim names the
# actual value (a key the step observed or was given, and an optional `at`
# path into it), a compare, and where the expected value comes from: an args
# key, `{ literal: v }`, or `{ from: key }` for an args key an earlier step
# filled. The judge returns every comparison it made, so a broken claim shows
# what was read.
require "ipaddr"
require_relative "text_fit"

module Nukadoko
  module Engine
    module Claims
      COMPARES = %w[equal not-equal contains-text starts-with-text ends-with-text has-item has-same-items has-fields
                    lacks-field fits-text fits-aria-snapshot is-a matches greater-than at-least less-than at-most judged-as].freeze

      # The ARIA snapshots nukadoko took of what observe returned, by the
      # value observe returned, so a claim judges the tree taken right
      # after that reading and never reads a live page.
      ARIA_TAKEN = ObjectSpace::WeakKeyMap.new #: ObjectSpace::WeakKeyMap[Hash[String, untyped], Hash[String, Hash[Symbol, String]]]
      ARIA_TAKES = "fits-aria-snapshot takes the ARIA snapshot of a locator or page that observe returns: return the locator or page itself, and nukadoko takes its snapshot"

      # Takes the ARIA snapshot of the locator or page at each path a
      # fits-aria-snapshot claim reads, once per reading. One path's failure
      # is that path's read, so taking them never raises.
      #: (Array[Hash[Symbol, untyped]], untyped) -> untyped
      def self.take_aria_snapshots(claims, observed)
        paths = claims.filter_map { _1[:actual].to_s if !_1[:each] && _1[:compare] == "fits-aria-snapshot" }
        judged = claims.filter_map { judged_path(_1) if !_1[:each] && _1[:compare] == "judged-as" }
        return observed if (paths + judged).empty? || !observed.is_a?(Hash)

        taken = paths.uniq.to_h { [_1, aria_snapshot_at(observed, _1.split("."))] }
        # A judged value is read as the tree the browser printed when it is
        # a locator or a page, and as its plain value when it is not, so a
        # judged path that holds neither keeps no entry.
        judged.uniq.each do |path|
          read = aria_snapshot_at(observed, path.split("."))
          taken["judged:#{path}"] = read unless read[:broken]
        end
        ARIA_TAKEN[observed] = taken
        observed
      end

      # The path a judged-as claim reads: its actual and, with no view, its at.
      #: (Hash[Symbol, untyped]) -> String
      def self.judged_path(claim)
        [claim[:actual], (claim[:at] unless claim[:view])].compact.join(".")
      end

      #: (untyped, Array[String]) -> Hash[Symbol, String]
      def self.aria_snapshot_at(root, segments)
        found = segments.reduce(root) do |current, segment|
          case current
          when Hash then current.key?(segment) ? current[segment] : current.fetch(segment.to_sym, :missing)
          when Array then segment.match?(/\A(0|[1-9][0-9]*)\z/) && segment.to_i < current.size ? current[segment.to_i] : :missing
          else :missing
          end
        end
        return { broken: "is undefined" } if found == :missing
        return { broken: "is #{aria_value_kind(found)}, and #{ARIA_TAKES}" } unless aria_snapshot_taker?(found)

        taker = found #: untyped
        text = begin
          taker.aria_snapshot
        rescue StandardError => e
          return { unjudged: "gave no ARIA snapshot: #{e.message.lines.first.to_s.chomp.delete_suffix(".")}, so the claim was not judged" }
        end
        text.is_a?(String) ? { text: text } : { unjudged: "gave #{aria_value_kind(text)} from ariaSnapshot() rather than a text, so the claim was not judged" }
      end

      # Only Playwright's own locator and page: a value step code wrote with
      # a method of that name would be a tree written in code.
      #: (untyped) -> bool
      def self.aria_snapshot_taker?(value)
        value.class.ancestors.any? { %w[Playwright::Locator Playwright::Page].include?(_1.name) }
      end

      # The phrase for a value that is not a locator or a page, as the
      # TypeScript engine names it.
      #: (untyped) -> String
      def self.aria_value_kind(value)
        case value
        when nil then "null"
        when String then "a string"
        when Numeric then "a number"
        when true, false then "a boolean"
        when Hash then "an Object"
        when Array then "an Array"
        else
          name = value.class.name.to_s.split("::").last.to_s
          name.empty? ? "an object of no class" : article_of(name)
        end
      end

      #: (String) -> String
      def self.article_of(word) = word.match?(/\A[aeiou]/i) ? "an #{word}" : "a #{word}"

      # The side a fits-aria-snapshot claim reads: the text of the snapshot
      # taken of the value at its actual path.
      #: (Hash[Symbol, untyped], untyped) -> Hash[Symbol, String]
      def self.aria_side(claim, observed)
        path = claim[:actual].to_s
        taken = (observed.is_a?(Hash) ? ARIA_TAKEN[observed] : nil)&.[](path) || { unjudged: "has no ARIA snapshot nukadoko took, so the claim was not judged" } #: Hash[Symbol, String]
        taken[:text] ? taken : taken.transform_values { "observe:#{path} #{_1}" }
      end

      #: (Array[Hash[Symbol, untyped]], untyped, untyped) -> Array[Hash[Symbol, untyped]]
      def self.judge(claims, observed, args)
        claims.map { judge_one(_1, observed, args) }
      end

      # `top` is what observe returned, which an expected { observe } reads
      # from inside an each as well. A claim on an item with no actual reads
      # the item itself.
      #: (Hash[Symbol, untyped], untyped, untyped, ?untyped) -> Hash[Symbol, untyped]
      def self.judge_one(claim, observed, args, top = observed)
        actual = dig(view(claim[:view], claim[:actual].nil? ? observed : read(observed, claim[:actual])), claim[:at])
        return judge_each(claim[:each], actual, args, top) if claim[:each]
        return judge_aria(claim, observed, args, top) if claim[:compare] == "fits-aria-snapshot"
        return judge_judged(claim, observed, args, top) if claim[:compare] == "judged-as" && aria_judged(claim, observed)

        if claim[:count]
          unless actual.is_a?(Array)
            # A count of no array has no value, and the record says so by leaving the actual out.
            return { compare: claim[:compare], expected: expected_value(claim, args, top), holds: false, reason: "count reads an array, and the value is #{article(json_type(actual))}" }
          end

          actual = actual.size
        end
        expected = expected_value(claim, args, top)
        result = compare(claim[:compare], actual, expected)
        { actual: actual, compare: claim[:compare], expected: expected, holds: result[:holds] == true, **(result[:for_judgment] ? { for_judgment: true } : {}),
          **(result[:reason] ? { reason: result[:reason] } : {}), **(result[:stopped] ? { reason: result[:stopped], unjudged: true } : {}) }
      end

      #: (Hash[Symbol, untyped], untyped, untyped, untyped) -> Hash[Symbol, untyped]
      def self.judge_aria(claim, observed, args, top)
        side = aria_side(claim, observed)
        expected = expected_value(claim, args, top)
        return { compare: claim[:compare], expected: expected, holds: false, reason: side[:broken] } if side[:broken]
        return { compare: claim[:compare], expected: expected, holds: false, reason: side[:unjudged], unjudged: true } if side[:unjudged]

        result = compare(claim[:compare], side[:text], expected)
        { actual: side[:text], compare: claim[:compare], expected: expected, holds: result[:holds] == true,
          **(result[:reason] ? { reason: result[:reason] } : {}), **(result[:stopped] ? { reason: result[:stopped], unjudged: true } : {}) }
      end

      # The tree nukadoko took of a judged value that is a locator or a page.
      #: (Hash[Symbol, untyped], untyped) -> Hash[Symbol, String]?
      def self.aria_judged(claim, observed)
        observed.is_a?(Hash) ? ARIA_TAKEN[observed]&.[]("judged:#{judged_path(claim)}") : nil
      end

      #: (Hash[Symbol, untyped], untyped, untyped, untyped) -> Hash[Symbol, untyped]
      def self.judge_judged(claim, observed, args, top)
        taken = aria_judged(claim, observed) || {}
        expected = expected_value(claim, args, top)
        return { compare: claim[:compare], expected: expected, holds: false, reason: "observe:#{judged_path(claim)} #{taken[:unjudged]}", unjudged: true, aria: true } if taken[:unjudged]

        { actual: taken[:text], compare: claim[:compare], expected: expected, holds: true, for_judgment: true, aria: true }
      end

      #: (Hash[Symbol, untyped], untyped, untyped, untyped) -> Hash[Symbol, untyped]
      def self.judge_each(each, items, args, top)
        chosen = Array(items).select { |item| (each[:where] || []).all? { judge_one(_1, item, args, top)[:holds] } }
        results = chosen.flat_map { |item| each[:claims].map { judge_one(_1, item, args, top) } }
        { each: results, chosen: chosen.size, holds: !chosen.empty? && results.all? { _1[:holds] } }
      end

      #: (Hash[Symbol, untyped], untyped, ?untyped) -> untyped
      def self.expected_value(claim, args, top = nil)
        value =
          case claim[:expected]
          in String => key then read(args, key)
          in { literal: literal } then literal
          in { from: String => key } then read(args, key)
          in { observe: String => path } then dig(read(top, path.split(".").first), path.split(".").drop(1).join(".").then { _1.empty? ? nil : _1 })
          end
        claim[:expected_view] == "json" ? JSON.parse(value) : value
      end

      VIEWS = %w[text lines comma-list json].freeze

      # A view reads a string as something else before `at` walks into it.
      #: (String?, untyped) -> untyped
      def self.view(name, value)
        return value unless name
        raise ArgumentError, "view #{name} reads a string, and the value is #{value.inspect}" unless value.is_a?(String)

        case name
        when "text" then Spaces.trim_end(value)
        when "lines" then (text = Spaces.trim_end(value)).empty? ? [] : text.split(/\r?\n/, -1)
        when "comma-list" then (text = Spaces.trim(value)).empty? ? [] : text.split(",", -1).map { Spaces.trim(_1) }
        when "json" then JSON.parse(value)
        else raise ArgumentError, "unknown view #{name}"
        end
      end

      #: (untyped, String | Symbol) -> untyped
      def self.read(hash, key)
        hash = hash.transform_keys(&:to_s) if hash.is_a?(Hash)
        hash.fetch(key.to_s)
      end

      #: (untyped, untyped) -> untyped
      def self.dig(value, path)
        return value unless path

        path.to_s.split(".").reduce(value) { |v, part| v.is_a?(Array) ? v[Integer(part)] : read(v, part) }
      end

      #: (untyped, untyped) -> bool
      def self.same?(a, b) = normal(a) == normal(b)

      #: (untyped) -> untyped
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

      #: (Integer, Integer, Integer) -> bool
      def self.calendar_day?(year, month, day)
        return false if month < 1 || month > 12 || day < 1

        leap = (year % 4).zero? && !(year % 100).zero? || (year % 400).zero?
        day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
      end

      #: (untyped) -> bool
      def self.date?(value)
        match = value.is_a?(String) ? DATE.match(value) : nil
        return false unless match

        year, month, day = match.captures.map(&:to_i)
        calendar_day?(year.to_i, month.to_i, day.to_i)
      end

      #: (untyped) -> bool
      def self.timestamp?(value)
        match = value.is_a?(String) ? TIMESTAMP.match(value) : nil
        return false unless match

        year, month, day, hour, minute, second = match.captures.map(&:to_i)
        return false unless calendar_day?(year.to_i, month.to_i, day.to_i)

        hour = hour.to_i
        minute = minute.to_i
        second = second.to_i
        offset = match[7].nil? || (match[7].to_i <= 23 && match[8].to_i <= 59)
        hour <= 23 && minute <= 59 && second <= 59 && offset
      end

      # A text a URL parser accepts can still be no URL a program wrote, so
      # the scheme needs "//" and no character a reader cannot see may appear.
      # The rest is what the WHATWG URL parser, which the TypeScript engine
      # uses, refuses for http and https: a missing host, a port that is not
      # a number up to 65535, a host with a character no domain may hold, and
      # an IPv4 or IPv6 address that does not parse. A path, a query, and a
      # fragment can hold anything, as a browser takes them.
      #: (untyped) -> bool
      def self.url?(value)
        return false unless value.is_a?(String) && value.match?(%r{\Ahttps?://}i) && !value.match?(/[\s\p{Cc}\p{Cf}]/)

        rest = value.sub(%r{\Ahttps?:[/\\]*}i, "")
        authority = rest[%r{\A[^/\\?#]*}].to_s
        at = authority.rindex("@")
        host_port = at ? authority[(at + 1)..].to_s : authority
        host, port = split_host_port(host_port)
        return false if host.nil? || host.empty?
        return false unless port.nil? || (port.match?(/\A\d*\z/) && port.to_i <= 65_535)

        host.start_with?("[") ? ipv6?(host[1...-1].to_s) : domain?(host)
      end

      # The host and the port of `host:port`, a colon inside brackets kept.
      #: (String) -> [String?, String?]
      def self.split_host_port(text)
        if text.start_with?("[")
          close = text.index("]")
          return [nil, nil] unless close

          after = text[(close + 1)..].to_s
          return [nil, nil] unless after.empty? || after.start_with?(":")

          return [text[0..close], after.empty? ? nil : after[1..]]
        end
        colon = text.index(":")
        colon ? [text[0...colon], text[(colon + 1)..]] : [text, nil]
      end

      #: (String) -> bool
      def self.ipv6?(text)
        return false if text.empty? || text.include?("%")

        IPAddr.new(text).ipv6?
      rescue IPAddr::Error
        false
      end

      FORBIDDEN_DOMAIN = /[\u0000- #%\/:<>?@\[\\\]^|\u007f]/

      # A host percent-decoded and mapped as UTS #46 maps it (NFKC, then
      # lower case), which holds no character a domain may not, and whose
      # last label, when it reads as a number, is an IPv4 address.
      #: (String) -> bool
      def self.domain?(host)
        decoded = host.b.gsub(/%(\h\h)/n) { Regexp.last_match(1).to_s.hex.chr }.force_encoding("UTF-8")
        return false unless decoded.valid_encoding?

        mapped = decoded.unicode_normalize(:nfkc).downcase.tr("。．｡", "...")
        return false if mapped.empty? || mapped.match?(FORBIDDEN_DOMAIN) || mapped.include?("�")

        labels = mapped.split(".", -1)
        # Node checks an xn-- label only in a host that is not all ASCII.
        return false if !decoded.ascii_only? && labels.any? { _1.start_with?("xn--") && !punycode_label?(_1) }
        last = labels.last == "" && labels.size > 1 ? labels[-2] : labels.last
        return true unless last.to_s.match?(/\A(?:\d+|0[xX]\h*)\z/)

        ipv4?(labels)
      end

      # Whether a label written as `xn--` decodes, under RFC 3492, to a
      # label UTS #46 keeps: one with a character outside ASCII, no control,
      # joiner, or unassigned character, and already in its mapped form.
      #: (String) -> bool
      def self.punycode_label?(label)
        decoded = punycode_decode(label[4..].to_s)
        !decoded.nil? && !decoded.ascii_only? && !decoded.match?(/[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}]/) && decoded == decoded.unicode_normalize(:nfkc).downcase
      end

      # RFC 3492's decoder, or nil for a text that does not decode.
      #: (String) -> String?
      def self.punycode_decode(text)
        return nil if text.empty?

        base, damp, tmin, tmax, skew = 36, 700, 1, 26, 38
        cut = text.rindex("-")
        output = cut ? text[0...cut].to_s.codepoints : []
        return nil unless output.all? { _1 < 0x80 }

        n = 128
        i = 0
        bias = 72
        index = cut ? cut + 1 : 0
        while index < text.length
          old = i
          w = 1
          k = base
          loop do
            return nil if index >= text.length

            char = text[index].to_s.downcase
            index += 1
            digit = if char.match?(/[a-z]/) then char.ord - 97
                    elsif char.match?(/[0-9]/) then char.ord - 22
                    else return nil
                    end
            i += digit * w
            t = if k <= bias then tmin elsif k >= bias + tmax then tmax else k - bias end
            break if digit < t

            w *= base - t
            k += base
          end
          length = output.size + 1
          delta = old.zero? ? (i - old) / damp : (i - old) / 2
          delta += delta / length
          k = 0
          while delta > ((base - tmin) * tmax) / 2
            delta /= base - tmin
            k += base
          end
          bias = k + (((base - tmin + 1) * delta) / (delta + skew))
          n += i / length
          i %= length
          return nil if n > 0x10FFFF || n.between?(0xD800, 0xDFFF)

          output.insert(i, n)
          i += 1
        end
        output.pack("U*")
      end

      # The WHATWG IPv4 parser: up to four parts, each decimal, octal with a
      # leading 0, or hex with 0x, every part but the last below 256 and the
      # last below what the parts before it leave.
      #: (Array[String]) -> bool
      def self.ipv4?(labels)
        parts = labels.last == "" ? labels[0...-1].to_a : labels
        return false if parts.empty? || parts.size > 4

        numbers = parts.map do |part|
          number = case part
                   when /\A0[xX]\h*\z/ then part[2..].to_s.empty? ? 0 : part[2..].to_s.hex
                   when /\A0[0-7]+\z/ then part.to_i(8)
                   when /\A0\d+\z/ then nil
                   when /\A\d+\z/ then part.to_i
                   end
          return false unless number

          number
        end
        return false if numbers[0...-1].to_a.any? { _1 > 255 }

        numbers.last.to_i < 256**(5 - numbers.size)
      end

      KIND_TESTS = {
        "string" => ->(v) { v.is_a?(String) }, "text" => ->(v) { v.is_a?(String) },
        "number" => ->(v) { v.is_a?(Numeric) }, "integer" => ->(v) { v.is_a?(Integer) || (v.is_a?(Float) && v.finite? && v == v.floor) },
        "boolean" => ->(v) { [true, false].include?(v) }, "list" => ->(v) { v.is_a?(Array) }, "array" => ->(v) { v.is_a?(Array) },
        "object" => ->(v) { v.is_a?(Hash) }, "null" => ->(v) { v.nil? }, "uuid" => ->(v) { v.is_a?(String) && v.match?(UUID) },
        "date" => method(:date?), "timestamp" => method(:timestamp?), "url" => method(:url?)
      }.freeze

      # The test of the kind `name` names, read trimmed and in any case.
      #: (String) -> untyped
      def self.value_kind(name) = KIND_TESTS[Spaces.trim(name).downcase]

      #: (untyped) -> String
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

      #: (String) -> String
      def self.article(type) = %w[array object].include?(type) ? "an #{type}" : "a #{type}"

      # JavaScript's trim, which takes Unicode spaces and a byte order mark.
      #: (String) -> bool
      def self.blank?(text) = Spaces.blank?(text)

      # Structural equality over JSON values: key order does not count, and
      # 1 equals 1.0, as JSON writes one number.
      #: (untyped, untyped) -> bool
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
      #: (Array[untyped], Array[untyped]) -> bool
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
      #: (untyped, untyped, ?Array[String | Integer]) -> Hash[Symbol, untyped]?
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
      #: (untyped, ?Array[String | Integer]) -> Array[String | Integer]?
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
      #: (String, untyped, untyped) -> Hash[Symbol, untyped]
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

          # Read as JavaScript's RegExp reads it, as the TypeScript engine does.
          pattern = begin
            JsPattern.compile(expected, timeout: PATTERN_TIMEOUT)
          rescue JsPattern::Invalid => e
            return { reason: "matches could not build a regular expression: #{e.message}" }
          end

          begin
            return { reason: "matches has a pattern that matches the empty string, so every string holds it" } if pattern.match?("")

            { holds: pattern.match?(JsPattern.units(actual)) }
          rescue Regexp::TimeoutError
            { stopped: "matches ran for more than #{PATTERN_TIMEOUT} seconds, so nukadoko stopped judging it" }
          end
        when "fits-text"
          return { reason: "fits-text reads two strings, and compares #{article(a_type)} with #{article(e_type)}" } unless a_type == "string" && e_type == "string"
          return { reason: "fits-text has an expected text of only whitespace, ... lines, [..], and [..:name], which almost every text holds" } if TextFit.only_stand_ins?(expected)

          { holds: TextFit.fit(actual, expected)[:fits] }
        when "fits-aria-snapshot"
          return { reason: "fits-aria-snapshot reads two ARIA snapshots as texts, and compares #{article(a_type)} with #{article(e_type)}" } unless a_type == "string" && e_type == "string"

          judged = AriaSnapshot.judge(actual, expected)
          return { reason: judged[:broken] } if judged[:broken]
          return { stopped: judged[:unjudged] } if judged[:unjudged]

          { holds: judged[:fits] }
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
          # The run reads a judged value and compares nothing: whether it
          # meets the quality is a judgment the table reads later
          # (lib/nukadoko/judgments.rb), so it holds the step up nowhere.
          { holds: true, for_judgment: true }
        else
          # A step whose claim names another compare never loads, so this
          # is a fault of nukadoko's, and the claim breaks saying so.
          { reason: "#{compare} is no compare nukadoko knows" }
        end
      end

      #: (String, untyped, untyped) -> bool
      def self.holds?(compare, actual, expected) = compare(compare, actual, expected)[:holds] == true
    end
  end
end
