# frozen_string_literal: true
# rbs_inline: enabled

# What `nuka check` can tell about a claim step's claims from the line it
# is bound on and the earlier lines of its scenario, in the TypeScript
# engine's words and order. A `from` value comes from the nearest earlier
# line that runs its one producer bound before this line, as a run fills
# it, so the producer's `returns` says what the value can hold: a path
# into it that is not there (`claim-path-unknown`), a path the step's own
# args drops (`claim-args-dropped`), a lacks-field on a field its object
# never keeps (`claim-field-stripped`), a count or an each on a value that
# is never an array (`claim-not-an-array`), and two sides that read one
# place, or an observe that receives the value it is compared with
# (`claim-compares-itself`). A line whose producer is missing or
# ambiguous is left to `from-order-violation`, and a type this module
# cannot read (`unknown`) is taken to have every path, so each finding can
# only end one way. A view reads text the step returned at run time, so no
# path after it is checked.
module Nukadoko
  module Engine
    module ClaimCheck
      Producer = Data.define(
        :line, #: Integer
        :step, #: singleton(Step)
        :key, #: String
      )

      # A place a side reads: the line of its producer, or observe, and the
      # path from there, a view or a count as one segment of its own and an
      # item of each as ANY.
      Place = Data.define(
        :origin, #: String
        :segments, #: Array[String]
        :text, #: String
      )

      INDEX = /\A(0|[1-9][0-9]*)\z/
      ANY = "*"

      module_function

      #: (String?) -> Array[String]?
      def segments_of(path)
        return [] if path.nil?

        parts = path.to_s.split(".", -1)
        parts.all? { !_1.empty? } && !parts.empty? ? parts : nil
      end

      # Every finding about the claim step bound on `index` of `resolved`,
      # the [step, captures] of each line, as [code, message].
      #: (Array[[singleton(Step), Hash[String, untyped]]?], Array[Integer], Integer) -> Array[[String, String]]
      def issues(resolved, lines, index)
        step, captures = resolved[index]
        claims = step&.claims
        return [] unless step && claims

        Run.new(step, claims, captures || {}, resolved, lines, index).issues
      end

      # The nearest earlier line that runs the one candidate producer bound
      # before this line, or nil when none or several are.
      #: (singleton(Step), String, Integer, Array[[singleton(Step), Hash[String, untyped]]?], Array[Integer]) -> Producer?
      def producer(step, key, index, resolved, lines)
        bound = (step.from[key] || []).filter_map do |candidate, field|
          before = (0...index).to_a.reverse.find { resolved[_1]&.first == candidate }
          before && Producer.new(line: lines[before], step: candidate, key: field.to_s)
        end
        bound.size == 1 ? bound.first : nil
      end

      # Follows `segments` through a schema as the run reads a value:
      # { schema: type } at the end, { open: true } past a type this module
      # cannot read, or { missing: index, keys: } at the first segment the
      # type does not have.
      #: (untyped, Array[String]) -> Hash[Symbol, untyped]
      def walk(schema, segments)
        return { open: true } if schema.nil?

        current = schema #: untyped
        segments.each_with_index do |segment, at|
          current = current[1] while current.is_a?(Array) && current[0] == :nullable
          case current
          when Schema
            field = current.fields.find { _1.name.to_s == segment }
            return { missing: at, keys: current.fields.map { _1.name.to_s } } unless field

            current = field.type
          when Array
            return { missing: at, keys: nil } unless current[0] == :array && segment.match?(INDEX)

            current = current[1]
          when :unknown then return { open: true }
          else return { missing: at, keys: nil }
          end
        end
        { schema: current }
      end

      NOUNS = { string: "a string", number: "a number", integer: "a number", boolean: "a boolean" }.freeze

      # What a value of `type` can be, as nouns, when none of them is an
      # array; nil when one may be.
      #: (untyped) -> Array[String]?
      def non_array_nouns(type)
        case type
        in [:nullable, inner] then (nouns = non_array_nouns(inner)) && (nouns | ["null"])
        in [:enum, _] then ["a string"]
        in Schema then ["an object"]
        in Symbol then NOUNS[type] && [NOUNS.fetch(type)]
        else nil
        end
      end

      # The keys of the object at `segments`, which keeps no key it does not
      # declare, as every object a Ruby schema declares does; nil for any
      # other type.
      #: (Schema?, Array[String]) -> Array[String]?
      def object_keys_at(schema, segments)
        type = walk(schema, segments)[:schema]
        type = type[1] while type.is_a?(Array) && type[0] == :nullable
        type.is_a?(Schema) ? type.fields.map { _1.name.to_s } : nil
      end

      # The field a lacks-field claim names on this line: a literal, or a
      # plain string key a capture fills with its own text.
      #: (Hash[Symbol, untyped], Hash[String, untyped], singleton(Step)) -> String?
      def lacked_field(entry, captures, step)
        return nil unless entry[:compare] == "lacks-field"

        expected = entry[:expected]
        name = if expected.is_a?(Hash) then expected[:literal].is_a?(String) ? expected[:literal] : nil
               elsif [nil, "text"].include?(entry[:expected_view]) && step.args[expected]&.type == :string && captures[expected].is_a?(String)
                 entry[:expected_view] == "text" ? captures[expected].rstrip : captures[expected]
               end
        name.nil? || name.strip.empty? ? nil : name
      end

      # The segments a claim reads before its view, as the run reads them:
      # its path, then its at when no view comes first; nil for a path that
      # is not one.
      #: (String?, String?, String?) -> Array[String]?
      def read_segments(path, view, at)
        segments = segments_of(path) or return nil
        view.nil? && at ? [*segments, *at.to_s.split(".")] : segments
      end

      #: (String, String?, String?) -> String
      def read_text(path, view, at) = view.nil? && at ? "#{path} at #{at}" : path

      #: (Hash[Symbol, untyped]) -> Array[String]?
      def item_segments(item)
        actual = segments_of(item[:actual]&.to_s)
        at = segments_of(item[:at]&.to_s)
        actual && at ? [*actual, *at] : nil
      end

      #: (Place, String?, String?, bool?) -> Place
      def shaped(place, view, at, count)
        place = Place.new(origin: place.origin, segments: [*place.segments, "##{view}"], text: "#{place.text} as #{view}") if view
        place = Place.new(origin: place.origin, segments: [*place.segments, *at.to_s.split(".")], text: "#{place.text} at #{at}") unless at.nil? || at.to_s.empty?
        count ? Place.new(origin: place.origin, segments: [*place.segments, "#count"], text: "the count of #{place.text}") : place
      end

      #: (Place, Place) -> bool
      def same_place?(a, b) = a.origin == b.origin && a.segments == b.segments

      #: (Place, Place) -> bool
      def overlap?(a, b)
        return false unless a.origin == b.origin

        size = [a.segments.size, b.segments.size].min
        a.segments.first(size).zip(b.segments.first(size)).all? { |x, y| x == y || (x == ANY && y.to_s.match?(INDEX)) || (y == ANY && x.to_s.match?(INDEX)) }
      end
    end
  end
end
