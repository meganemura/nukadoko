# frozen_string_literal: true
# rbs_inline: enabled

# What `nuka check` can tell about a claim step's claims from the line it
# is bound on and the earlier lines of its scenario, in the TypeScript
# engine's words. A `from` value comes from the nearest earlier line that
# runs its one producer bound before this line, as a run fills it, so the
# producer's `returns` says what the value can hold: a path into it that is
# not there (`claim-path-unknown`), a lacks-field on a field its object
# never keeps (`claim-field-stripped`), an each on a value that is never an
# array (`claim-not-an-array`), and two sides that read one place
# (`claim-compares-itself`). A line whose producer is missing or ambiguous
# is left to `from-order-violation`, and a type this module cannot read
# (`unknown`) is taken to have every path, so each finding can only end one
# way. A view reads text the step returned at run time, so no path after it
# is checked.
module Nukadoko
  module Engine
    module ClaimCheck
      Producer = Data.define(
        :line, #: Integer
        :step, #: singleton(Step)
        :key, #: String
      )

      # A place a side reads: the line of its producer, or observe, and the
      # path from there, a view as one segment of its own.
      Place = Data.define(
        :origin, #: String
        :segments, #: Array[String]
        :text, #: String
      )

      INDEX = /\A(0|[1-9][0-9]*)\z/

      module_function

      # [line index, code, message] for each finding about the claim step
      # bound on `index` of `resolved`, the [step, captures] of each line.
      #: (Array[[singleton(Step), Hash[String, untyped]]?], Array[Integer], Integer) -> Array[[String, String]]
      def issues(resolved, lines, index)
        step, captures = resolved[index]
        claims = step&.claims
        return [] unless step && claims

        captures ||= {}

        found = [] #: Array[[String, String]]
        report = ->(code, message) { found << [code, %(Step "#{step.step_name}"'s #{message})] }
        producer_of = ->(key) { producer(step, key, index, resolved, lines) }
        claims.each_with_index do |claim, number|
          label = "claims[#{number}]"
          check_expected_from(label, claim, step, producer_of, report)
          actual = claim[:actual].to_s
          from = step.from.key?(actual)
          at = claim[:view] ? nil : split(claim[:at])
          producer = from ? producer_of.(actual) : nil
          top = producer && walk(producer.step.returns, [producer.key])
          report.("claim-path-unknown", missing("#{label}.actual", actual, producer, top, [producer.key])) if producer && top && top[:missing]
          if producer && top&.key?(:schema) && at
            path = [producer.key, *at]
            if claim[:each]
              not_an_array(label, "reads each item of", producer, path, claim[:at] ? "#{actual} at #{claim[:at]}" : actual, report)
              (at.empty? ? each_entries(label, claim) : []).each do |entry_label, entry|
                inside = entry[:view] ? nil : [*split(entry[:actual]), *split(entry[:at])]
                next unless inside

                named = inside.empty? ? "each item" : "#{inside.join(".")} of each item"
                stripped(entry_label, entry, captures, step, producer, [*path, "0", *inside], [actual, *at, "0", *inside], "#{named} of #{actual}", report)
              end
            else
              stripped(label, claim, captures, step, producer, path, [actual, *at], claim[:at] ? "#{actual} at #{claim[:at]}" : actual, report)
            end
          end
          next if claim[:each]

          actual_place = place(from ? "from" : "observe", actual, producer_of)
          actual_place = shaped(actual_place, claim[:view], claim[:at]) if actual_place
          expected_place = claim[:expected].is_a?(Hash) && claim[:expected][:from] ? place("from", claim[:expected][:from].to_s, producer_of) : nil
          compares_itself(label, actual_place, expected_place, report)
        end
        found
      end

      #: (String, Hash[Symbol, untyped]) -> Array[[String, Hash[Symbol, untyped]]]
      def each_entries(label, claim)
        each = claim[:each]
        [*(each[:where] || []).each_with_index.map { ["#{label}.each.where[#{_2}]", _1] },
         *each[:claims].each_with_index.map { ["#{label}.each.claims[#{_2}]", _1] }]
      end

      #: (String?) -> Array[String]
      def split(path) = path.nil? || path.to_s.empty? ? [] : path.to_s.split(".")

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

      # Follows `segments` through a returns schema as the run reads a
      # value: { schema: type } at the end, { open: true } past a type this
      # module cannot read, or { missing: index, keys: } at the first
      # segment the type does not have.
      #: (Schema?, Array[String]) -> Hash[Symbol, untyped]
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

      #: (String, String, Producer, Hash[Symbol, untyped], Array[String]) -> String
      def missing(label, path, producer, walk, segments)
        at = walk[:missing]
        segment = segments[at]
        where = at.zero? ? "at the top of its result" : "under #{segments.first(at).join(".")}"
        has = if walk[:keys].nil? then ""
              elsif walk[:keys].empty? then ", which has no keys"
              else ", which has #{walk[:keys].join(", ")}"
              end
        %(#{label} reads "#{path}", and step "#{producer.step.step_name}" on line #{producer.line} returns nothing at "#{segment}" #{where}#{has}. ) +
          "The value would be undefined, so the claim would always break"
      end

      #: (String, Hash[Symbol, untyped], singleton(Step), ^(String) -> Producer?, ^(String, String) -> void) -> void
      def check_expected_from(label, claim, step, producer_of, report)
        entries = claim[:each] ? each_entries(label, claim) : [[label, claim]] #: Array[[String, Hash[Symbol, untyped]]]
        entries.each do |entry_label, entry|
          expected = entry[:expected] #: untyped
          next unless expected.is_a?(Hash) && expected[:from]

          path = split(expected[:from])
          head = path.first.to_s
          producer = (producer_of.(head) if step.from.key?(head))
          next unless producer

          upstream = [producer.key, *path.drop(1)]
          walk = walk(producer.step.returns, upstream)
          report.("claim-path-unknown", missing("#{entry_label}.expected.from", expected[:from].to_s, producer, walk, upstream)) if walk[:missing]
        end
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

      #: (String, String, Producer, Array[String], String, ^(String, String) -> void) -> void
      def not_an_array(label, reads, producer, path, what, report)
        walked = walk(producer.step.returns, path)
        nouns = walked.key?(:schema) ? non_array_nouns(walked[:schema]) : nil
        return unless nouns

        report.("claim-not-an-array", %(#{label} #{reads} #{what}, and step "#{producer.step.step_name}" on line #{producer.line} returns #{nouns.join(" or ")} there, never an array, so the claim never holds, whatever the behaviour is))
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

      # The keys of the object at `segments`, which keeps no key it does not
      # declare, as every object a Ruby schema declares does; nil for any
      # other type.
      #: (Schema?, Array[String]) -> Array[String]?
      def object_keys_at(schema, segments)
        walked = walk(schema, segments)
        type = walked[:schema]
        type = type[1] while type.is_a?(Array) && type[0] == :nullable
        type.is_a?(Schema) ? type.fields.map { _1.name.to_s } : nil
      end

      #: (String, Hash[Symbol, untyped], Hash[String, untyped], singleton(Step), Producer, Array[String], Array[String], String, ^(String, String) -> void) -> void
      def stripped(label, entry, captures, step, producer, path, args_path, named, report)
        field = lacked_field(entry, captures, step) or return
        where = label.include?(".each.where[")
        outcome = where ? "where never leaves an item out, whatever the behaviour is" : "the claim never breaks, whatever the behaviour is"
        keys = object_keys_at(producer.step.returns, path)
        if keys.nil? || keys.include?(field)
          args_keys = object_keys_at(step.args, args_path)
          return if args_keys.nil? || args_keys.include?(field)

          report.("claim-args-dropped",
                  "#{label} is lacks-field #{JSON.generate(field)} on #{named}, and the step's own args declares that value through an object schema that declares " \
                  "#{args_keys.empty? ? "no keys" : args_keys.join(", ")}, which drops any key it does not declare. Step \"#{producer.step.step_name}\" on line #{producer.line} " \
                  "may return #{field}, and the run leaves a claim unjudged when its args schema took a key out of the value it reads, so #{outcome}")
          return
        end
        report.("claim-field-stripped",
                "#{label} is lacks-field #{JSON.generate(field)} on #{named}, and step \"#{producer.step.step_name}\" on line #{producer.line} " \
                "returns that value through an object schema that declares #{keys.empty? ? "no keys" : keys.join(", ")}, which drops any key it does not declare, or refuses it as a strict object. " \
                "#{field} is never there, so #{outcome}")
      end

      #: (String, String, ^(String) -> Producer?) -> Place?
      def place(source, path, producer_of)
        segments = split(path)
        return Place.new(origin: "observe", segments: segments, text: "the observe path #{path}") if source == "observe"

        producer = producer_of.(segments.first.to_s) or return nil
        upstream = [producer.key, *segments.drop(1)]
        Place.new(origin: "line:#{producer.line}", segments: upstream, text: %(#{upstream.join(".")} of step "#{producer.step.step_name}" on line #{producer.line}))
      end

      #: (Place, String?, String?) -> Place
      def shaped(place, view, at)
        place = Place.new(origin: place.origin, segments: [*place.segments, "##{view}"], text: "#{place.text} as #{view}") if view
        return place if at.nil? || at.to_s.empty?

        Place.new(origin: place.origin, segments: [*place.segments, *at.to_s.split(".")], text: "#{place.text} at #{at}")
      end

      #: (String, Place?, Place?, ^(String, String) -> void) -> void
      def compares_itself(label, actual, expected, report)
        return unless actual && expected && actual.origin == expected.origin && actual.segments == expected.segments

        where = actual.text == expected.text ? "#{actual.text} on both sides" : "#{actual.text} as its actual value and #{expected.text} as its expected value, one place"
        report.("claim-compares-itself", "#{label} reads #{where}, so it holds whatever the behaviour is")
      end
    end
  end
end
