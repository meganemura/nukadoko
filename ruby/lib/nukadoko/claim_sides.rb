# frozen_string_literal: true
# rbs_inline: enabled

# Responsibility: the two sides of a top-level comparison claim, read as the
# TypeScript engine reads them: where each value sits (its place, whose
# label a reason names), the plain JSON copy a claim judges, and what stops
# a claim before any compare runs (a value that is undefined, one that is
# not plain JSON, a view that cannot read it, a claim that compares a value
# with itself or with one observe could have returned). It reads; the
# compares stay in Claims.compare. A claim on each item of a list is read
# elsewhere.
module Nukadoko
  module Engine
    module ClaimSides
      Place = Data.define(
        :origin, #: String
        :segments, #: Array[String]
        :label, #: String
        :open, #: bool
      )

      # What one side read: a value, or why the claim breaks or is not judged.
      Side = Data.define(
        :place, #: Place
        :found, #: Hash[Symbol, untyped]
      )

      OBSERVE = Place.new(origin: "observe", segments: [], label: "observe:", open: false)
      LITERAL = Place.new(origin: "literal", segments: [], label: "literal:", open: false)
      SAFE = 2**53 - 1
      MAX_DEPTH = 256
      INDEX = /\A(0|[1-9][0-9]*)\z/

      # Where a claim reads from: what observe returned with the from values
      # merged in, the args, whether the step observes, its from keys, the
      # label of each args key's origin, and the args keys observe received.
      Inputs = Data.define(
        :observed, #: untyped
        :args, #: untyped
        :observes, #: bool
        :from_keys, #: Array[String]
        :labels, #: ^(String) -> String
        :received, #: Array[String]
        # Why a claim cannot compare with an args key, for each key the
        # matched pattern fills with a parameter type that has a transformer.
        :transformed, #: Hash[String, String]
      )

      # A Data block's methods are its own, but rbs-inline reads only a class
      # body, so they are written in one.
      class Inputs
        #: (?transformed: Hash[String, String], **untyped) -> void
        def initialize(transformed: {}, **rest) = super
      end

      #: (Place, String?) -> Place
      def self.place_at(place, path)
        return place if path.nil? || path.empty?

        separator = if place.open then " at "
                    elsif place.label.end_with?(":") then ""
                    else "."
                    end
        Place.new(origin: place.origin, segments: place.segments + path.split("."), label: "#{place.label}#{separator}#{path}", open: false)
      end

      #: (Place, String?) -> Place
      def self.place_viewed(place, view)
        return place unless view

        Place.new(origin: place.origin, segments: [*place.segments, "##{view}"], label: "#{place.label} as #{view}", open: true)
      end

      #: (Place, bool?) -> Place
      def self.place_counted(place, count)
        return place unless count == true

        Place.new(origin: place.origin, segments: [*place.segments, "#count"], label: "count of #{place.label}", open: false)
      end

      #: (Place, Place) -> bool
      def self.same_place?(a, b) = a.origin == b.origin && a.segments == b.segments

      #: (Place, Place) -> bool
      def self.overlap?(a, b)
        size = [a.segments.size, b.segments.size].min
        a.origin == b.origin && a.segments.take(size) == b.segments.take(size)
      end

      #: (String, Inputs) -> Place
      def self.arg_place(key, inputs)
        Place.new(origin: inputs.labels.(key), segments: [], label: inputs.labels.(key), open: false)
      end

      #: (String) -> Array[String]
      def self.segments(path)
        parts = path.split(".", -1)
        parts.all? { !_1.empty? } ? parts : [path]
      end

      # The value at `segments` inside `root`, or the index of the first
      # segment that finds nothing. nil is JSON's null, which is a value.
      #: (untyped, Array[String]) -> Hash[Symbol, untyped]
      def self.value_at(root, segments)
        current = root
        segments.each_with_index do |segment, index|
          case current
          when Hash
            key = if current.key?(segment) then segment
                  elsif current.key?(segment.to_sym) then segment.to_sym
                  end
            return { missing: index } if key.nil?

            current = current[key]
          when Array
            return { missing: index } unless segment.match?(INDEX) && segment.to_i < current.size

            current = current[segment.to_i]
          else return { missing: index }
          end
        end
        { found: current }
      end

      #: (untyped, Array[String]) -> Hash[Symbol, untyped]
      def self.read_at(root, segments)
        found = value_at(root, segments)
        return found unless found.key?(:found)

        taken = snapshot(found[:found])
        taken[:refused] ? { refused: taken[:refused].merge(at: segments + taken[:refused][:at]) } : taken
      end

      #: (String) -> String
      def self.article(word) = word.match?(/\A[aeiou]/i) ? "an #{word}" : "a #{word}"

      # The plain JSON copy a claim judges, as JavaScript holds it, or where
      # the first part that is not plain JSON sits and what it is. A whole
      # float is the integer JavaScript's one number type would hold, so
      # 2500.0 is judged and shown as 2500; a symbol is its name.
      #: (untyped, ?Integer) -> Hash[Symbol, untyped]
      def self.snapshot(value, max_depth = MAX_DEPTH)
        ancestors = {} #: Hash[Integer, true]
        refused = nil #: Hash[Symbol, untyped]?
        refuse = lambda do |at, problem, limit = nil|
          refused = { at: at, problem: problem, **(limit ? { limit: limit } : {}) }
          nil
        end
        copy = lambda do |current, at|
          case current
          when nil, true, false, String then current
          when Symbol then current.to_s
          # JavaScript holds such an integer only as the nearest double.
          when Integer then current.abs <= SAFE ? current : refuse.(at, "is the integer #{AriaSnapshot.js_number(current.to_f)}, beyond Number.MAX_SAFE_INTEGER")
          when Float
            next refuse.(at, "is NaN") if current.nan?
            next refuse.(at, "is #{current.positive? ? "" : "-"}Infinity") if current.infinite?
            next current unless current == current.floor
            next current.to_i if current.abs <= SAFE

            refuse.(at, "is the integer #{AriaSnapshot.js_number(current)}, beyond Number.MAX_SAFE_INTEGER")
          when Array, Hash
            next refuse.(at, "refers back to a value that holds it") if ancestors[current.object_id]
            next refuse.([], "nests deeper than #{max_depth} levels", max_depth) if at.size >= max_depth

            ancestors[current.object_id] = true
            out = if current.is_a?(Array)
                    current.each_with_index.map do |item, index|
                      item = copy.(item, [*at, index.to_s])
                      break if refused

                      item
                    end
                  else
                    pairs = current.map do |key, item|
                      next refuse.(at, "has a key that is #{article(key.class.name.to_s)}") unless key.is_a?(String) || key.is_a?(Symbol)

                      item = copy.(item, [*at, key.to_s])
                      break if refused

                      [key.to_s, item]
                    end
                    refused ? nil : js_order(pairs.to_h)
                  end
            ancestors.delete(current.object_id)
            out
          else
            name = current.class.name
            refuse.(at, name.nil? || name.empty? ? "is an object of no class" : "is #{article(name.split("::").last.to_s)}")
          end
        end
        result = copy.(value, [])
        refused ? { refused: refused } : { value: result }
      end

      # A JavaScript object lists its array-index keys first, in ascending
      # order, then its other keys in the order they were added.
      #: (Hash[String, untyped]) -> Hash[String, untyped]
      def self.js_order(hash)
        index = hash.keys.select { _1.match?(INDEX) && _1.to_i < 2**32 - 1 }
        return hash if index.empty?

        (index.sort_by(&:to_i) + (hash.keys - index)).to_h { [_1, hash[_1]] }
      end

      #: (Place) -> String
      def self.name_of(place) = place.label.end_with?(":") ? "the value observe returned" : place.label

      #: (Place, Hash[Symbol, untyped]) -> String
      def self.refusal_reason(place, refusal)
        name = name_of(place_at(place, refusal[:at].join(".")))
        return "#{name} #{refusal[:problem]}, so the claim was not judged: the record keeps no value nested that deep" if refusal[:limit]

        "#{name} #{refusal[:problem]}, which is not plain JSON, so the claim was not judged: a claim judges a plain JSON copy of the value it reads"
      end

      #: (Integer, Place, Array[String]) -> String
      def self.first_missing(index, base, rest)
        return "" if index >= rest.size - 1
        return ", since #{name_of(base)} is undefined" if index.negative?

        ", since #{name_of(place_at(base, rest.take(index).join(".")))} has nothing at #{rest[index]}"
      end

      #: (Hash[Symbol, untyped], Place, Array[String], Integer, ?^(Place) -> String) -> Side
      def self.side_of(read, base, rest, skip, name = method(:name_of))
        place = place_at(base, rest.join("."))
        if read[:refused]
          return Side.new(place: place, found: { unjudged: refusal_reason(base, read[:refused].merge(at: read[:refused][:at].drop(skip))) })
        end
        return Side.new(place: place, found: { broken: "#{name.(place)} is undefined#{first_missing(read[:missing] - skip, base, rest)}" }) if read.key?(:missing)

        Side.new(place: place, found: { value: read[:value] })
      end

      #: (Array[String], Inputs, ?^(Place) -> String) -> Side
      def self.arg_side(segments, inputs, name = method(:name_of))
        head, *rest = segments
        side_of(read_at(inputs.args, segments), arg_place(head.to_s, inputs), rest, 1, name)
      end

      # The side a claim's actual names, read at its path and, with no
      # view, at its at too; `at_read` says the at was read here.
      #: (Hash[Symbol, untyped], Inputs) -> [Side, bool]
      def self.top_side(claim, inputs)
        path = segments(claim[:actual].to_s)
        read_segments = claim[:view].nil? && claim[:at] ? path + claim[:at].to_s.split(".") : path
        at_read = read_segments.size > path.size
        from = inputs.from_keys.include?(path.first) || !inputs.observes
        read = from ? read_at(inputs.args, read_segments) : read_at(inputs.observed, read_segments)
        base = from ? arg_place(path.first.to_s, inputs) : OBSERVE
        skip = from ? 1 : 0
        rest = path.drop(skip)
        if at_read && read.key?(:missing) && read[:missing] >= path.size
          place = place_at(base, rest.join("."))
          return [Side.new(place: place, found: { broken: "#{place.label} has nothing at #{claim[:at]}" }), at_read]
        end

        [side_of(read, base, rest, skip), at_read]
      end

      # The value after a view, or why the view could not read it.
      #: (String?, untyped) -> Hash[Symbol, untyped]
      def self.apply_view(view, value)
        return { value: value } unless view
        return { reason: "view #{view} reads a string, and the value is #{article(Claims.json_type(value))}" } unless value.is_a?(String)
        return { value: Claims.view(view, value) } unless view == "json"

        parsed = begin
          JsJson.parse(value)
        rescue JSON::ParserError => e
          return { reason: "view json could not parse the value: #{e.message.lines.first.to_s.strip}" }
        end
        snapshot(parsed)
      end

      #: (Side, String?, String?, ?bool) -> Side
      def self.shaped(side, view, at, at_read = false)
        viewed_place = place_viewed(side.place, view)
        place = place_at(viewed_place, at)
        return Side.new(place: place, found: side.found) unless side.found.key?(:value)
        return Side.new(place: place, found: side.found) if at_read

        viewed = apply_view(view, side.found[:value])
        return Side.new(place: place, found: { broken: viewed[:reason] }) if viewed[:reason]
        return Side.new(place: place, found: { unjudged: refusal_reason(viewed_place, viewed[:refused]) }) if viewed[:refused]
        return Side.new(place: viewed_place, found: { value: viewed[:value] }) if at.nil?

        read = read_at(viewed[:value], at.split("."))
        return Side.new(place: place, found: { value: read[:value] }) if read.key?(:value)

        Side.new(place: place, found: { broken: "#{viewed_place.label} has nothing at #{at}" })
      end

      #: (Side, bool?) -> Side
      def self.counted(side, count)
        return side unless count == true

        place = place_counted(side.place, count)
        return Side.new(place: place, found: side.found) unless side.found.key?(:value)

        value = side.found[:value]
        return Side.new(place: place, found: { broken: "count reads an array, and the value is #{article(Claims.json_type(value))}" }) unless value.is_a?(Array)

        Side.new(place: place, found: { value: value.size })
      end

      # The expected side, and whether observe gave it.
      #: (Hash[Symbol, untyped], Inputs) -> [Side, bool]
      def self.expected_side(claim, inputs)
        name = ->(place) { "the expected value #{place.label}" }
        case claim[:expected]
        in String => key if (reason = inputs.transformed[key])
          [Side.new(place: arg_place(key, inputs), found: { unjudged: reason }), false]
        in String => key then [shaped(arg_side([key], inputs, name), claim[:expected_view], nil), false]
        in { from: String => key } then [arg_side(segments(key), inputs, name), false]
        in { observe: String => path } then [side_of(read_at(inputs.observed, segments(path)), OBSERVE, segments(path), 0, name), true]
        in { literal: literal } then [Side.new(place: LITERAL, found: { value: literal.is_a?(Array) ? [] : literal }), false]
        end
      end

      # What stops a claim before any compare runs, or nil.
      #: (Side, Side, bool, Inputs) -> Hash[Symbol, String]?
      def self.precondition(actual, expected, from_observe, inputs)
        [actual, expected].each do |side|
          return { broken: side.found[:broken] } if side.found[:broken]
          return { unjudged: side.found[:unjudged] } if side.found[:unjudged]
        end
        return { broken: "both sides read #{actual.place.label}, so the claim compares a value with itself" } if same_place?(actual.place, expected.place)

        received = observe_received(expected.place, inputs, "the expected value reads")
        received ||= observe_received(actual.place, inputs, "the actual value reads") if from_observe
        return received if received
        if from_observe && [true, false].include?(expected.found[:value])
          return { broken: "the expected value #{expected.place.label} is a boolean observe computed, which is a judgment made in code: " \
                           "return the thing measured and let the claim compare it" }
        end

        nil
      end

      #: (Place, Inputs, String) -> Hash[Symbol, String]?
      def self.observe_received(place, inputs, reads)
        inputs.received.each do |key|
          input = arg_place(key, inputs)
          next unless overlap?(input, place)

          return { broken: "observe received args.#{key}, which is #{input.label}, and #{reads} #{place.label}, " \
                           "so observe could return the value the claim compares it with" }
        end
        nil
      end

      # A top-level comparison claim, judged as Claims.judge_one reports one.
      #: (Hash[Symbol, untyped], Inputs) -> Hash[Symbol, untyped]
      def self.judge(claim, inputs)
        raw, at_read = top_side(claim, inputs)
        judge_comparison(claim, raw, inputs, at_read)
      rescue StandardError => e
        unjudgeable(claim, e)
      end
      
      # One comparison on a side already read: a top-level claim's, or one
      # item's under an each.
      #: (Hash[Symbol, untyped], Side, Inputs, ?bool) -> Hash[Symbol, untyped]
      def self.judge_comparison(claim, raw, inputs, at_read = false)
        expected, from_observe = expected_side(claim, inputs)
        actual = counted(shaped(raw, claim[:view], claim[:at], at_read), claim[:count])
        base = { **(actual.found.key?(:value) ? { actual: actual.found[:value] } : {}), compare: claim[:compare],
                 **(expected.found.key?(:value) ? { expected: expected.found[:value] } : {}) }
        stop = precondition(actual, expected, from_observe, inputs)
        return base.merge(holds: false, reason: stop[:broken] || stop[:unjudged], **(stop[:unjudged] ? { unjudged: true } : {})) if stop
        return base.merge(holds: true, for_judgment: true) if claim[:compare] == "judged-as"
      
        result = Claims.compare(claim[:compare], actual.found[:value], expected.found[:value])
        base.merge(holds: result[:holds] == true, **(result[:reason] ? { reason: result[:reason] } : {}),
                   **(result[:stopped] ? { reason: result[:stopped], unjudged: true } : {}))
      rescue StandardError => e
        unjudgeable(claim, e)
      end
      
      #: (Hash[Symbol, untyped], StandardError) -> Hash[Symbol, untyped]
      def self.unjudgeable(claim, error)
        { compare: claim[:compare], holds: false, reason: "nukadoko could not judge this claim: #{error.message}", unjudged: true }
      end
      
      # The array an each reads, after its view and at.
      #: (Hash[Symbol, untyped], Inputs) -> Side
      def self.array_side(claim, inputs)
        raw, at_read = top_side(claim, inputs)
        shaped(raw, claim[:view], claim[:at], at_read)
      end
      
      # The side an item claim reads: the item, or a path inside it. The item
      # is part of a snapshot, so a read inside it finds a value or nothing.
      #: (untyped, Place, Hash[Symbol, untyped]) -> Side
      def self.item_side(item, item_place, entry)
        path = entry[:actual] ? segments(entry[:actual].to_s) : []
        side_of(read_at(item, path), item_place, path, 0)
      end
      
      # What ends an each before any item: a declaration whose expected value
      # observe received, or reads through what observe returned while observe
      # received the array, does not depend on an item, and an empty array
      # would hide it. Then a where clause that implies an item claim.
      #: (Hash[Symbol, untyped], Place, Inputs) -> Hash[Symbol, String]?
      def self.each_stop(claim, array, inputs)
        entries = (claim[:each][:where] || []).each_with_index.map { ["each.where[#{_2}]", _1] } +
                  claim[:each][:claims].each_with_index.map { ["each.claims[#{_2}]", _1] }
        entries.each do |label, entry|
          expected, from_observe = expected_side(entry, inputs)
          stop = observe_received(expected.place, inputs, "#{label}'s expected value reads")
          stop ||= observe_received(array, inputs, "#{label} reads each item of") if from_observe
          return stop if stop
        end
        implied = where_implication(claim, inputs)
        implied ? { broken: implied } : nil
      end
      
      # The first where clause and item claim that read one value where the
      # clause implies the claim whatever the value is, as the reason that
      # breaks the each: the claim holds on every item where selects, so
      # "every item" measures nothing.
      #: (Hash[Symbol, untyped], Inputs) -> String?
      def self.where_implication(claim, inputs)
        value_of = lambda do |entry|
          side, = expected_side(entry, inputs)
          side.found.key?(:value) ? side.found : nil
        end
        (claim[:each][:where] || []).each_with_index do |where, where_index|
          next unless where[:compare] == "not-equal" || ClaimRules::ORDER_COMPARES.include?(where[:compare])
      
          path = where[:actual] ? segments(where[:actual].to_s) : []
          path += where[:at].to_s.split(".") if where[:view].nil? && where[:at]
          claim[:each][:claims].each_with_index do |entry, claim_index|
            next unless ClaimRules.one_item_value?(where, entry)
      
            selects = value_of.(where)
            holds = value_of.(entry)
            next unless selects && holds && where_implies?(where[:compare], selects[:value], entry[:compare], holds[:value])
      
            viewed = where[:view] ? " as #{where[:view]}#{" at #{where[:at]}" if where[:at]}" : ""
            what = "#{"count of " if where[:count] == true}#{path.empty? ? "value" : path.join(".")}#{viewed}"
            return "each.where[#{where_index}] selects the items whose #{what} is #{where[:compare]} #{JsJson.generate(selects[:value])}, " \
                   "and every such item holds each.claims[#{claim_index}], #{entry[:compare]} #{JsJson.generate(holds[:value])}, " \
                   "whatever the data, so the claim measures nothing"
          end
        end
        nil
      end
      
      # Whether every value a where clause selects holds an item claim on the
      # same value: the same order direction with a bound at least as strict,
      # not-equal against the same value, or an is-a whose kind is the one JSON
      # type the clause can compare.
      #: (String, untyped, String, untyped) -> bool
      def self.where_implies?(where, where_value, claim, claim_value)
        if claim == "is-a"
          kind = claim_value.is_a?(String) ? Spaces.trim(claim_value).downcase : nil
          type = if where == "not-equal" then Claims.json_type(where_value)
                 elsif ClaimRules::ORDER_COMPARES.include?(where) && where_value.is_a?(Numeric) then "number"
                 end
          return !kind.nil? && !type.nil? && ClaimRules::KIND_JSON_TYPES[kind] == type
        end
        if where == "not-equal"
          return claim == "not-equal" && Claims.json_type(where_value) == Claims.json_type(claim_value) && Claims.deep_equal?(where_value, claim_value)
        end
        return false unless where_value.is_a?(Numeric) && claim_value.is_a?(Numeric)
      
        up = %w[greater-than at-least]
        down = %w[less-than at-most]
        strict = %w[greater-than less-than]
        loose_to_strict = !strict.include?(where) && strict.include?(claim)
        return loose_to_strict ? where_value > claim_value : where_value >= claim_value if up.include?(where) && up.include?(claim)
        return loose_to_strict ? where_value < claim_value : where_value <= claim_value if down.include?(where) && down.include?(claim)
      
        false
      end
    end
  end
end
