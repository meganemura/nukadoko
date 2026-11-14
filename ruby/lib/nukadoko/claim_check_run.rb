# frozen_string_literal: true
# rbs_inline: enabled

# The claim checks of one claim step on one scenario line, kept apart from
# ClaimCheck's own module functions, which rbs-inline would otherwise read
# into this class.
module Nukadoko
  module Engine
    # One claim step on one line.
    class ClaimCheck::Run
      #: (singleton(Step), Array[Hash[Symbol, untyped]], Hash[String, untyped], Array[[singleton(Step), Hash[String, untyped]]?], Array[Integer], Integer) -> void
      def initialize(step, claims, captures, resolved, lines, index)
        @step = step
        @claims = claims
        @captures = captures
        @resolved = resolved
        @lines = lines
        @index = index
        @from_keys = step.from.keys.map(&:to_s) #: Array[String]
        @producers = {} #: Hash[String, ClaimCheck::Producer?]
        @found = [] #: Array[[String, String]]
        @not_observe = [] #: Array[[String, ClaimCheck::Place]]
      end

      #: () -> Array[[String, String]]
      def issues
        @claims.each_with_index { |claim, number| claim_issues(claim, "claims[#{number}]") }
        observe_receives if @step.method_defined?(:observe)
        @found
      end

      private

      #: (String, String) -> void
      def report(code, message) = @found << [code, %(Step "#{@step.step_name}"'s #{message})]

      #: (String) -> ClaimCheck::Producer?
      def producer_of(key)
        return @producers[key] if @producers.key?(key)

        @producers[key] = @from_keys.include?(key) ? ClaimCheck.producer(@step, key, @index, @resolved, @lines) : nil
      end

      #: (String?) -> ClaimCheck::Producer?
      def from_producer(head)
        head && @from_keys.include?(head) ? producer_of(head) : nil
      end

      # The type a from path ends in, reporting a path the producer does
      # not return; nil when the path is not a from path, is unresolved,
      # or ends in a type this module cannot read.
      #: (String, String) -> untyped
      def from_path(label, path)
        segments = ClaimCheck.segments_of(path)
        producer = from_producer(segments&.first) or return nil
        upstream = [producer.key, *segments.to_a.drop(1)]
        walked = ClaimCheck.walk(producer.step.returns, upstream)
        if walked[:missing]
          report("claim-path-unknown", missing(label, path, producer, walked, upstream))
          return nil
        end
        walked[:schema]
      end

      #: (String, String, ClaimCheck::Producer, Hash[Symbol, untyped], Array[String]) -> String
      def missing(label, path, producer, walked, segments)
        at = walked[:missing]
        where = at.zero? ? "at the top of its result" : "under #{segments.first(at).join(".")}"
        has = if walked[:keys].nil? then ""
              elsif walked[:keys].empty? then ", which has no keys"
              else ", which has #{walked[:keys].join(", ")}"
              end
        %(#{label} reads "#{path}", and step "#{producer.step.step_name}" on line #{producer.line} returns nothing at "#{segments[at]}" #{where}#{has}. ) +
          "The value would be undefined, so the claim would always break"
      end

      # A from path the step's own args takes out of the value before a
      # claim reads it: the first key an object of args does not declare,
      # where the producer may return one.
      #: (String, String, Array[String]?) -> void
      def args_drop(label, path, segments)
        producer = from_producer(segments&.first) or return
        read = segments || []
        walked = ClaimCheck.walk(@step.args, read)
        return unless walked[:missing] && walked[:missing] >= 1 && walked[:keys]
        return if ClaimCheck.walk(producer.step.returns, [producer.key, *read.drop(1)])[:missing]

        at = walked[:missing] #: Integer
        keys = walked[:keys].empty? ? "no keys" : walked[:keys].join(", ")
        report("claim-args-dropped",
               "#{label} reads #{path}, and the step's own args declares #{read.first(at).join(".")} through an object schema that declares #{keys}, " \
               "which drops #{read[at]} as a key it does not declare, or refuses it as a strict object. Step \"#{producer.step.step_name}\" on line #{producer.line} " \
               "may return a value there: the run leaves a claim unjudged when its args schema changed the value it reads, and breaks it when the value is undefined, " \
               "so the claim never holds, whatever the behaviour is")
      end

      #: (String, untyped) -> void
      def expected_args_drop(label, expected)
        return unless expected.is_a?(Hash) && expected[:from]

        args_drop("#{label}.expected.from", expected[:from].to_s, ClaimCheck.segments_of(expected[:from].to_s))
      end

      #: (String, String, String, Array[String], String) -> void
      def not_an_array(label, reads, path, inside, what)
        segments = ClaimCheck.segments_of(path)
        producer = from_producer(segments&.first) or return
        walked = ClaimCheck.walk(producer.step.returns, [producer.key, *segments.to_a.drop(1), *inside])
        nouns = walked.key?(:schema) ? ClaimCheck.non_array_nouns(walked[:schema]) : nil
        return unless nouns

        report("claim-not-an-array", %(#{label} #{reads} #{what}, and step "#{producer.step.step_name}" on line #{producer.line} returns #{nouns.join(" or ")} there, never an array, so the claim never holds, whatever the behaviour is))
      end

      #: (String, Hash[Symbol, untyped], String, Array[String], String, bool) -> void
      def stripped(label, entry, actual_path, inside, path, where)
        field = ClaimCheck.lacked_field(entry, @captures, @step) or return
        segments = ClaimCheck.segments_of(actual_path)
        producer = from_producer(segments&.first) or return
        segments = segments.to_a
        keys = ClaimCheck.object_keys_at(producer.step.returns, [producer.key, *segments.drop(1), *inside])
        outcome = where ? "where never leaves an item out, whatever the behaviour is" : "the claim never breaks, whatever the behaviour is"
        if keys.nil? || keys.include?(field)
          args_keys = ClaimCheck.object_keys_at(@step.args, [*segments, *inside])
          return if args_keys.nil? || args_keys.include?(field)

          report("claim-args-dropped",
                 "#{label} is lacks-field #{JSON.generate(field)} on #{path}, and the step's own args declares that value through an object schema that declares " \
                 "#{args_keys.empty? ? "no keys" : args_keys.join(", ")}, which drops any key it does not declare. Step \"#{producer.step.step_name}\" on line #{producer.line} " \
                 "may return #{field}, and the run leaves a claim unjudged when its args schema took a key out of the value it reads, so #{outcome}")
          return
        end
        report("claim-field-stripped",
               "#{label} is lacks-field #{JSON.generate(field)} on #{path}, and step \"#{producer.step.step_name}\" on line #{producer.line} " \
               "returns that value through an object schema that declares #{keys.empty? ? "no keys" : keys.join(", ")}, which drops any key it does not declare, or refuses it as a strict object. " \
               "#{field} is never there, so #{outcome}")
      end

      #: (String, String) -> ClaimCheck::Place?
      def place(source, path)
        segments = ClaimCheck.segments_of(path) or return nil
        return ClaimCheck::Place.new(origin: "observe", segments: segments, text: "the observe path #{path}") if source == "observe"

        producer = producer_of(segments.first.to_s) or return nil
        upstream = [producer.key, *segments.drop(1)]
        ClaimCheck::Place.new(origin: "line:#{producer.line}", segments: upstream, text: %(#{upstream.join(".")} of step "#{producer.step.step_name}" on line #{producer.line}))
      end

      #: (untyped) -> ClaimCheck::Place?
      def expected_place(expected)
        return nil unless expected.is_a?(Hash)
        return place("from", expected[:from].to_s) if expected[:from]
        return place("observe", expected[:observe].to_s) if expected[:observe]

        nil
      end

      #: (String, ClaimCheck::Place?, ClaimCheck::Place?) -> void
      def compares_itself(label, actual, expected)
        return unless actual && expected && ClaimCheck.same_place?(actual, expected)

        where = actual.text == expected.text ? "#{actual.text} on both sides" : "#{actual.text} as its actual value and #{expected.text} as its expected value, one place"
        report("claim-compares-itself", "#{label} reads #{where}, so it holds whatever the behaviour is")
      end

      #: (String, untyped) -> void
      def note_expected_from(label, expected)
        return unless expected.is_a?(Hash) && expected[:from]

        at = place("from", expected[:from].to_s)
        @not_observe << ["#{label}.expected", at] if at
      end

      #: (String, untyped, ClaimCheck::Place?, String) -> void
      def note_actual_from(label, expected, actual, source)
        return unless actual && source == "from" && expected.is_a?(Hash) && expected.key?(:observe)

        @not_observe << ["#{label}.actual", actual]
      end

      # Each where clause and item claim of an each, with its label and
      # whether it is a where clause.
      #: (String, Hash[Symbol, untyped]) -> Array[[String, Hash[Symbol, untyped], bool]]
      def each_entries(label, claim)
        each = claim[:each]
        [*(each[:where] || []).each_with_index.map { ["#{label}.each.where[#{_2}]", _1, true] },
         *each[:claims].each_with_index.map { ["#{label}.each.claims[#{_2}]", _1, false] }]
      end

      #: (Hash[Symbol, untyped], String) -> void
      def claim_issues(claim, label)
        actual = claim[:actual].to_s
        read_path = ClaimCheck.read_segments(actual, claim[:view], claim[:at]&.to_s)
        args_drop("#{label}.actual", ClaimCheck.read_text(actual, claim[:view], claim[:at]&.to_s), read_path)
        actual_schema = from_path("#{label}.actual", actual)
        source = @from_keys.include?(ClaimCheck.segments_of(actual)&.first.to_s) ? "from" : "observe"
        top = place(source, actual)
        actual_place = top && ClaimCheck.shaped(top, claim[:view], claim[:at], claim[:count])
        return each_issues(claim, label, actual, read_path, actual_schema, source, actual_place) if claim[:each]

        expected = claim[:expected]
        from_path("#{label}.expected.from", expected[:from].to_s) if expected.is_a?(Hash) && expected[:from]
        expected_args_drop(label, expected)
        at = claim[:view].nil? ? (claim[:at].nil? ? [] : ClaimCheck.segments_of(claim[:at].to_s)) : nil
        named = claim[:at].nil? ? actual : "#{actual} at #{claim[:at]}"
        not_an_array(label, "counts the items of", actual, at, named) if at && claim[:count] == true
        stripped(label, claim, actual, at, named, false) if !actual_schema.nil? && at
        note_expected_from(label, expected)
        note_actual_from(label, expected, actual_place, source)
        compares_itself(label, actual_place, expected_place(expected))
      end

      #: (Hash[Symbol, untyped], String, String, Array[String]?, untyped, String, ClaimCheck::Place?) -> void
      def each_issues(claim, label, actual, read_path, actual_schema, source, actual_place)
        each_at = claim[:view].nil? ? (claim[:at].nil? ? [] : ClaimCheck.segments_of(claim[:at].to_s)) : nil
        not_an_array(label, "reads each item of", actual, each_at, claim[:at].nil? ? actual : "#{actual} at #{claim[:at]}") if each_at
        entries = each_entries(label, claim)
        if !actual_schema.nil? && claim[:view].nil? && claim[:at].nil?
          item_paths(label, claim, actual_schema)
          entries.each do |item_label, item, where|
            inside = item[:view].nil? ? ClaimCheck.item_segments(item) : nil
            next unless inside

            named = inside.empty? ? "each item" : "#{inside.join(".")} of each item"
            stripped(item_label, item, actual, ["0", *inside], "#{named} of #{actual}", where)
            not_an_array(item_label, "counts the items of", actual, ["0", *inside], "#{named} of #{actual}") if item[:count] == true
          end
        end
        entries.each do |item_label, item, _where|
          expected = item[:expected]
          from_path("#{item_label}.expected.from", expected[:from].to_s) if expected.is_a?(Hash) && expected[:from]
          expected_args_drop(item_label, expected)
          in_item = claim[:view].nil? && read_path ? ClaimCheck.read_segments(item[:actual]&.to_s, item[:view], item[:at]&.to_s) : nil
          if in_item && read_path
            text = ClaimCheck.read_text(item[:actual]&.to_s || "the item", item[:view], item[:at]&.to_s)
            args_drop("#{item_label}.actual", "#{text} of each item of #{actual}", [*read_path, "0", *in_item])
          end
          note_expected_from(item_label, expected)
          item_path = item[:actual].nil? ? [] : ClaimCheck.segments_of(item[:actual].to_s)
          if actual_place.nil? || item_path.nil?
            note_actual_from(item_label, expected, actual_place, source)
            next
          end
          under = ClaimCheck::Place.new(origin: actual_place.origin, segments: [*actual_place.segments, ClaimCheck::ANY, *item_path], text: "#{item[:actual] || "item"} of each item of #{actual_place.text}")
          item_place = ClaimCheck.shaped(under, item[:view], item[:at], item[:count])
          note_actual_from(item_label, expected, item_place, source)
          compares_itself(item_label, item_place, expected_place(expected))
        end
      end

      # Item paths of an each against the array's item type.
      #: (String, Hash[Symbol, untyped], untyped) -> void
      def item_paths(label, claim, array_type)
        element = ClaimCheck.walk(array_type, ["0"])
        return unless element.key?(:schema)

        each_entries(label, claim).each do |item_label, item, _where|
          next if item[:actual].nil?

          segments = ClaimCheck.segments_of(item[:actual].to_s) or next
          walked = ClaimCheck.walk(element[:schema], segments)
          next unless walked[:missing]

          has = if walked[:keys].nil? then ""
                elsif walked[:keys].empty? then ", which has no keys"
                else ", which has #{walked[:keys].join(", ")}"
                end
          report("claim-path-unknown", %(#{item_label}.actual reads "#{item[:actual]}" on each item of #{claim[:actual]}, and an item has nothing at "#{segments[walked[:missing]]}"#{has}. ) +
                                       "The value would be undefined, so the claim would always break")
        end
      end

      # An observe that receives a value an expected from reads, or the
      # value an actual from reads when the claim takes its expected
      # value from observe, could return the value it is compared with.
      #: () -> void
      def observe_receives
        withheld = ClaimRules.withheld_keys(@claims, @from_keys)
        @from_keys.each do |key|
          next if withheld.key?(key)

          input = place("from", key) or next
          hit = @not_observe.find { ClaimCheck.overlap?(input, _2) }
          next unless hit

          report("claim-compares-itself",
                 "observe receives args.#{key}, which is #{input.text}, and its #{hit[0]} reads #{hit[1].text}, so observe could return the value the claim compares it with. " \
                 "Take #{key} out of this step's from, so observe does not receive it, or fill it from another step")
        end
      end
    end
  end
end
