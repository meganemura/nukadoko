# frozen_string_literal: true
# rbs_inline: enabled

# The claims a step may declare, as the TypeScript engine's defineStep
# reads them: each refusal names a claim the run could judge only one way
# on every line, or one that lets the line or step code decide what the
# claim compares. `first_problem` gives the first refusal in the order the
# TypeScript engine meets it, in its words, so `nuka check` reports one
# step-file-import-failed per step in both engines. A Ruby args schema has
# no optional key, no default, and no rewrite, so those refusals have no
# Ruby counterpart.
module Nukadoko
  module Engine
    module ClaimRules
      class Refused < StandardError; end

      # What the rules read about the step besides its claims.
      Shape = Data.define(
        :patterns, #: Array[String]
        :args_keys, #: Array[String]
        :string_args, #: Array[String]
        :from_keys, #: Array[String]
        :capture_keys, #: Array[String]
        :observe, #: bool
      )

      VIEWS = %w[text lines json comma-list].freeze
      COMPARISON_KEYS = %w[actual view at count compare expected expected_view].freeze
      EACH_CLAIM_KEYS = %w[actual view at each].freeze
      EACH_KEYS = %w[where claims].freeze
      PATH = /\A[^.]+(\.[^.]+)*\z/
      VIEW_MAKES = { "text" => "string", "lines" => "array", "comma-list" => "array", "json" => nil }.freeze
      KIND_JSON_TYPES = { "string" => "string", "text" => "string", "number" => "number", "boolean" => "boolean", "list" => "array",
                          "array" => "array", "object" => "object", "null" => "null" }.freeze
      COUNT_COMPARES = %w[equal not-equal greater-than at-least less-than at-most].freeze
      ORDER_COMPARES = %w[greater-than at-least less-than at-most].freeze
      ACTUAL_READS = { "contains-text" => "string", "starts-with-text" => "string", "ends-with-text" => "string", "matches" => "string",
                       "fits-text" => "string", "has-item" => "array", "has-same-items" => "array", "has-fields" => "object",
                       "lacks-field" => "object", "greater-than" => "number", "at-least" => "number", "less-than" => "number",
                       "at-most" => "number" }.freeze
      READS_INSTEAD = {
        "string" => "Read the text with view text, or claim each line or item with each",
        "array" => "Read the text with view lines or comma-list, or claim a value that is an array",
        "object" => "Read the text with view json, or claim a value that is an object",
        "number" => "Read the text with view json, or count the lines or items with count: true"
      }.freeze
      WHERE_DECIDES = %w[equal has-same-items has-fields lacks-field fits-text is-a contains-text starts-with-text ends-with-text matches has-item].freeze

      module_function

      # The first reason the TypeScript engine's defineStep would refuse
      # these claims, or nil.
      #: (untyped, Shape) -> String?
      def first_problem(claims, shape)
        validate(claims, shape)
        nil
      rescue Refused => e
        e.message
      end

      #: (untyped) -> String
      def describe(value)
        JsJson.generate(value)
      rescue StandardError
        value.inspect
      end

      #: (String) -> String
      def article(word) = word.match?(/\A[aeiou]/) ? "an #{word}" : "a #{word}"

      #: (String) -> bot
      def refuse(message) = raise(Refused, message)

      #: (untyped) -> Array[String]?
      def segments(path) = path.is_a?(String) && path.match?(PATH) ? path.split(".") : nil

      #: (String, untyped, bool) -> void
      def check_path(label, path, optional)
        return if path.nil? && optional

        refuse(%(#{label} must be a path of dot-separated keys, such as "result.exit_code"; got #{path.nil? ? "undefined" : describe(path)})) unless segments(path)
      end

      #: (String, Hash[Symbol, untyped], Array[String], String) -> void
      def check_keys(label, value, allowed, what)
        unknown = value.find { |key, entry| !entry.nil? && !allowed.include?(key.to_s) }&.first
        refuse(%(#{label} has the key "#{unknown}", which #{what} does not have. It has #{allowed.join(", ")})) if unknown
      end

      #: (String, Hash[Symbol, untyped]) -> void
      def check_common(label, claim)
        refuse("#{label}.view must be one of #{VIEWS.join(", ")}; got #{describe(claim[:view])}") if !claim[:view].nil? && !VIEWS.include?(claim[:view])
        check_path("#{label}.at", claim[:at], true)
      end

      #: (untyped) -> Hash[Symbol, untyped]?
      def literal_of(expected) = expected.is_a?(Hash) && expected.key?(:literal) ? expected : nil

      #: (untyped) -> bool
      def literal_value?(value)
        case value
        when String, true, false, nil then true
        when Integer then true
        when Float then value.finite?
        when Array then value.empty?
        else false
        end
      end

      #: (String, Hash[Symbol, untyped], Shape) -> void
      def check_expected_view(label, claim, shape)
        view = claim[:expected_view]
        return if view.nil?

        refuse("#{label}.expected_view must be one of #{VIEWS.join(", ")}; got #{describe(view)}") unless VIEWS.include?(view)
        refuse("#{label}.expected_view reads the text a line states, and #{label}.expected is not an args key the sentence fills") unless claim[:expected].is_a?(String)
        return if shape.string_args.include?(claim[:expected])

        refuse("#{label}.expected_view reads text, and args.#{claim[:expected]} is not a plain z.string(), so the line's text is not what reaches the view")
      end

      #: (String, untyped, untyped, Shape, bool) -> void
      def check_expected(label, expected, compare, shape, from_observe)
        if expected.is_a?(String)
          refuse(%(#{label}.expected names "#{expected}", which from fills from an earlier step. Write { from: "#{expected}" } so the record says so)) if shape.from_keys.include?(expected)
          refuse(%(#{label}.expected names "#{expected}", which is not a key of args)) unless shape.args_keys.include?(expected)
          return
        end
        refuse("#{label}.expected must be an args key the sentence fills, { from }, { literal }, or { observe }; got #{expected.nil? ? "undefined" : describe(expected)}") unless expected.is_a?(Hash)
        refuse("#{label}.expected must have exactly one of from, literal, observe; got #{describe(expected.keys.map(&:to_s))}") unless expected.size == 1

        if expected.key?(:from)
          check_path("#{label}.expected.from", expected[:from], false)
          key = expected[:from].split(".").first
          refuse(%(#{label}.expected.from starts with "#{key}", which is not a key of this step's from)) unless shape.from_keys.include?(key)
          if shape.capture_keys.include?(key)
            refuse(%(#{label}.expected.from starts with "#{key}", which a pattern captures, so a line fills it and no earlier step does. Name it as a sentence key, or take it out of the pattern))
          end
        elsif expected.key?(:observe)
          check_path("#{label}.expected.observe", expected[:observe], false)
          refuse("#{label}.expected reads observe, and the step has no observe") unless shape.observe
        elsif expected.key?(:literal)
          check_literal(label, expected[:literal], compare, shape, from_observe)
        else
          refuse("#{label}.expected must have exactly one of from, literal, observe; got #{describe(expected.keys.map(&:to_s))}")
        end
      end

      #: (String, untyped, untyped, Shape, bool) -> void
      def check_literal(label, literal, compare, shape, from_observe)
        refuse("#{label}.expected.literal must be a string, a finite number, a boolean, null, or []; got #{describe(literal)}") unless literal_value?(literal)
        if [true, false].include?(literal) && from_observe
          refuse("#{label}.expected is the boolean #{literal}, and its actual comes from observe. A boolean computed by observe is a judgment made in code: " \
                 "return the thing measured (a count, a text, a list) and let the claim compare it")
        end
        unless Literal.statement_of_all(shape.patterns, literal)
          where = shape.patterns.empty? ? "the step has no pattern, so no sentence states it" : "no fixed word of #{shape.patterns.map { %("#{_1}") }.join(" and ")} states it"
          refuse("#{label}.expected is the literal #{describe(literal)}, and #{where}. Put the value in the sentence, as fixed words or as a capture the claim names")
        end
        shape.patterns.each do |pattern|
          stated = Literal.statement(pattern, literal)
          next if stated.nil? || stated.compare.nil? || stated.compare == compare

          words = stated.compare == "not-equal" ? %(words "#{(stated.negated_by || "not").downcase} #{stated.words}" rule out) : %(word "#{stated.words}" fixes)
          refuse("#{label}.expected is the literal #{describe(literal)}, which the #{words}, and #{label}.compare is #{describe(compare)}. " \
                 'A value a word fixes is compared with equal alone, or with not-equal alone right after the word "not", "neither", or "nor" ("is not empty"): ' \
                 "another compare against it holds for nearly anything, and the word does not show it")
        end
      end

      #: (String, Hash[Symbol, untyped]) -> void
      def check_count(label, claim)
        return if claim[:count].nil?

        refuse("#{label}.count must be true, or left out; got #{describe(claim[:count])}") unless claim[:count] == true
        makes = "#{label} counts the items of its actual value, which makes a number"
        unless COUNT_COMPARES.include?(claim[:compare])
          refuse("#{makes}, and #{claim[:compare]} does not compare two numbers, so the claim would break on every line or hold on every line. Compare the count with #{COUNT_COMPARES.join(", ")}")
        end
        if claim[:view] == "text" && claim[:at].nil?
          refuse("#{label} counts the items of a value read through view text, which always makes a string and never an array, so the claim always breaks. Read the text with view lines to count its lines")
        end
        literal = literal_of(claim[:expected])
        if literal && !literal[:literal].is_a?(Numeric)
          refuse("#{makes}, and its expected value is the literal #{describe(literal[:literal])}, which is never a number, so the claim always breaks. " \
                 "State the number in the pattern, as digits or a number word, and write it as a number literal")
        end
        view = claim[:expected_view]
        made = view && VIEW_MAKES[view]
        return unless made

        refuse("#{makes}, and its expected value is read through expected_view #{view}, which makes #{article(made)} and never a number, so the claim always breaks. Capture the number with {int}, or leave expected_view out")
      end

      #: (String, Hash[Symbol, untyped]) -> void
      def check_sides(label, claim)
        literal = literal_of(claim[:expected])
        case claim[:compare]
        when "has-fields"
          if literal
            refuse("#{label}.expected is the literal #{describe(literal[:literal])}, which is never an object, and has-fields compares two objects, so the claim always breaks. " \
                   'Take the expected object from the docstring, read as JSON with expected_view: "json"')
          end
          return if !claim[:expected].is_a?(String) || claim[:expected_view] == "json"

          view = claim[:expected_view]
          what = view.nil? ? "is args.#{claim[:expected]}, which a line fills with a capture's value, the docstring's text, or the table's cells" : "reads args.#{claim[:expected]} through expected_view #{view}, which makes #{article(VIEW_MAKES.fetch(view).to_s)}"
          refuse(%(#{label}.expected #{what}, never an object, so has-fields always breaks. Read the docstring as JSON with expected_view: "json"))
        when "lacks-field"
          if literal && !literal[:literal].is_a?(String)
            refuse("#{label}.expected is the literal #{describe(literal[:literal])}, which is never the name of a field, and lacks-field names the field its actual object lacks, so the claim always breaks. " \
                   "State the field's name in the pattern's fixed words")
          end
          view = claim[:expected_view]
          return unless view && VIEW_MAKES[view] == "array"

          refuse("#{label}.expected reads args.#{claim[:expected]} through expected_view #{view}, which makes an array and never the name of a field, so lacks-field always breaks. Name one field, and leave expected_view out")
        when "fits-text"
          expected = claim[:expected]
          return if !expected.is_a?(Hash) || literal

          key, what = if expected.key?(:from) then ["from", "a value a step returned"]
                      elsif expected.key?(:observe) then ["observe", "a value observe read"]
                      end
          return unless key

          refuse(%(#{label}.expected reads { #{key}: #{describe(expected[key.to_sym])} }, #{what}, and fits-text reads each "..." line, each "[..]", and each "[..:name]" of its expected text as a stand-in, so a value that holds one lets text nobody stated fit. ) +
                 "Take the expected text from the sentence: a docstring, a capture, or a literal")
        when "is-a"
          return unless literal

          kind = literal[:literal].is_a?(String) && Claims::VALUE_KINDS.find { _1.casecmp?(literal[:literal]) }
          refuse("#{label}.expected is the literal #{describe(literal[:literal])}, and is-a names one of the kinds #{Claims::VALUE_KINDS.join(", ")}, so the claim always breaks. State one of them in the pattern's fixed words") unless kind

          view = claim[:view]
          made = view.nil? || !claim[:at].nil? ? nil : VIEW_MAKES[view]
          return if made.nil? || KIND_JSON_TYPES[kind.downcase] != made

          instead = made == "string" ? "Name a kind a string may not be, such as uuid, date, timestamp, or url, or claim the value itself" : "Claim what its items are with each, or claim the value itself"
          refuse("#{label} reads its actual value through view #{view}, which always makes #{article(made.to_s)}, so is-a #{describe(literal[:literal])} holds whenever the view applies and states nothing. #{instead}")
        end
      end

      #: (String, Hash[Symbol, untyped]) -> void
      def check_actual_view(label, claim)
        return if claim[:view].nil? || !claim[:at].nil? || !claim[:count].nil?

        reads = ACTUAL_READS[claim[:compare]]
        made = VIEW_MAKES[claim[:view]]
        return if reads.nil? || made.nil? || made == reads

        refuse("#{label} reads its actual value through view #{claim[:view]}, which always makes #{article(made)} and never #{article(reads)}, so #{claim[:compare]} always breaks. #{READS_INSTEAD.fetch(reads)}")
      end

      #: (String, Hash[Symbol, untyped], Shape, bool, bool) -> void
      def check_aria_snapshot(label, claim, shape, item, from_observe)
        takes = "fits-aria-snapshot takes the ARIA snapshot of a locator or page that observe returns"
        if item
          refuse("#{label} compares with fits-aria-snapshot, and an item of each is plain JSON, never a locator or a page, while #{takes}, so the claim always breaks. " \
                 "Claim the snapshot at the top level, with actual naming the key observe returns it under")
        end
        unless from_observe
          refuse("#{label}.actual reads a value an earlier step returned, which is plain JSON and never a locator or a page, and #{takes}, so the claim always breaks. Return the locator or page from observe, and name its key in actual")
        end
        %i[view at count].each do |key|
          next if claim[key].nil?

          refuse("#{label} has #{key}, and #{takes} at actual, with nothing between the value and the snapshot. Name the locator or page in actual, and drop #{key}")
        end
        expected = claim[:expected]
        if (literal = literal_of(expected))
          refuse("#{label}.expected is the literal #{describe(literal[:literal])}, and the expected ARIA snapshot of fits-aria-snapshot is a tree of lines the line states, which the pattern's fixed words are not. Take the expected snapshot from the docstring")
        end
        if expected.is_a?(Hash)
          source = expected.key?(:from) ? "a value a step returned" : "a value observe read"
          refuse("#{label}.expected reads #{describe(expected)}, #{source}, and the expected ARIA snapshot of fits-aria-snapshot is the tree the line states: " \
                 "a tree a program wrote could be the actual tree copied, so the claim would hold whatever the page shows. Take the expected snapshot from the docstring")
        end
        unless claim[:expected_view].nil?
          refuse("#{label}.expected_view is #{describe(claim[:expected_view])}, and fits-aria-snapshot reads the expected ARIA snapshot from the text the line states, as it is. Drop expected_view")
        end
        return unless expected.is_a?(String) && !shape.string_args.include?(expected)

        refuse("#{label}.expected is args.#{expected}, which is not a plain z.string(), and fits-aria-snapshot reads the expected ARIA snapshot from the text the line states, " \
               "so a table or a schema of another type would never reach it as that text. Declare args.#{expected} as z.string(), and fill it with the docstring")
      end

      #: (String, Hash[Symbol, untyped], bool) -> void
      def check_judged(label, claim, item)
        if item
          refuse("#{label} compares with judged-as inside each, and a judgment cites one value a Then read, not one of many items. Claim the value at the top level, and name it in actual")
        end
        expected = claim[:expected]
        if expected.is_a?(Hash) && !expected.key?(:literal)
          refuse("#{label}.expected reads #{describe(expected)}, and the quality a judge reads a judged-as value against is the sentence's own words, so a reader of the feature sees what was asked. " \
                 "Take it from a capture, or from the pattern's fixed words as a literal")
        end
        return if claim[:expected_view].nil?

        refuse("#{label}.expected_view is #{describe(claim[:expected_view])}, and a judge reads the quality as the sentence states it. Drop expected_view")
      end

      #: (String, Hash[Symbol, untyped], Shape, bool, bool) -> void
      def check_comparison(label, claim, shape, item, from_observe)
        refuse("#{label} has each, which a claim inside each cannot have") unless claim[:each].nil?
        check_keys(label, claim, COMPARISON_KEYS, item ? "a claim on one item" : "a claim")
        check_path("#{label}.actual", claim[:actual], item)
        check_common(label, claim)
        refuse("#{label}.compare must be one of #{Claims::COMPARES.join(", ")}; got #{claim[:compare].nil? ? "undefined" : describe(claim[:compare])}") unless Claims::COMPARES.include?(claim[:compare])
        check_expected(label, claim[:expected], claim[:compare], shape, from_observe)
        check_expected_view(label, claim, shape)
        check_count(label, claim)
        check_sides(label, claim)
        check_actual_view(label, claim)
        check_aria_snapshot(label, claim, shape, item, from_observe) if claim[:compare] == "fits-aria-snapshot"
        check_judged(label, claim, item) if claim[:compare] == "judged-as"
      end

      #: (Hash[Symbol, untyped]) -> Array[String]
      def item_path(claim)
        split = ->(path) { path.is_a?(String) ? (segments(path) || [path]) : [] }
        [*split.(claim[:actual]), *split.(claim[:at])]
      end

      #: (Hash[Symbol, untyped]) -> Array[String]
      def item_read_path(claim)
        path = item_path(claim)
        return path unless claim[:compare] == "lacks-field"

        literal = literal_of(claim[:expected])
        literal && literal[:literal].is_a?(String) ? [*path, literal[:literal]] : path
      end

      #: (Array[String], Array[String]) -> bool
      def overlap?(a, b) = a.first([a.size, b.size].min) == b.first([a.size, b.size].min)

      #: (Hash[Symbol, untyped], Hash[Symbol, untyped]) -> bool
      def one_item_value?(a, b)
        return false if a[:view] != b[:view] || a[:count] != b[:count]
        return item_path(a) == item_path(b) if a[:view].nil?

        item_path({ actual: a[:actual] }) == item_path({ actual: b[:actual] }) && item_path({ at: a[:at] }) == item_path({ at: b[:at] })
      end

      #: (Array[String]) -> String
      def described_item(path) = path.empty? ? "the item itself" : "the item at #{path.join(".")}"

      #: (untyped) -> String?
      def literal_json_type(literal)
        case literal
        when nil then "null"
        when Array then "array"
        when String then "string"
        when Numeric then "number"
        when true, false then "boolean"
        end
      end

      #: (untyped, Shape) -> void
      def validate(claims, shape)
        refuse("claims must be a non-empty array. A claim step with no claim passes without judging anything") if !claims.is_a?(Array) || claims.empty?

        claims.each_with_index do |claim, index|
          label = "claims[#{index}]"
          refuse("#{label} must be an object with actual, compare, and expected, or actual and each") unless claim.is_a?(Hash)

          check_path("#{label}.actual", claim[:actual], false)
          head = claim[:actual].split(".").first.to_s
          from_observe = !shape.from_keys.include?(head)
          refuse(%(#{label}.actual starts with "#{head}", which is not a key of this step's from, and the step has no observe to read it)) if from_observe && !shape.observe
          if !from_observe && shape.capture_keys.include?(head)
            refuse(%(#{label}.actual starts with "#{head}", which a pattern captures, so a line would fill the value the claim measures. Take it out of the pattern, so an earlier step fills it))
          end
          if from_observe && shape.args_keys.include?(head)
            refuse(%(#{label}.actual starts with "#{head}", an args key the sentence fills. A claim's actual is a value an earlier step returned (a from key) or one observe read))
          end
          if claim[:each].nil?
            check_comparison(label, claim, shape, false, from_observe)
            next
          end
          refuse("#{label} has both each and compare/expected. A claim compares one value, or applies each to an array") unless claim[:compare].nil? && claim[:expected].nil?

          check_keys(label, claim, EACH_CLAIM_KEYS, "a claim with each")
          check_common(label, claim)
          check_each(label, claim[:each], shape, from_observe)
        end
        check_observe_read(claims, shape)
        check_captures_read(claims, shape)
      end

      #: (String, untyped, Shape, bool) -> void
      def check_each(label, each, shape, from_observe)
        refuse("#{label}.each.claims must be a non-empty array of claims on one item") if !each.is_a?(Hash) || !each[:claims].is_a?(Array) || each[:claims].empty?
        check_keys("#{label}.each", each, EACH_KEYS, "each")
        refuse("#{label}.each.where must be a non-empty array of claims on one item, or left out") if !each[:where].nil? && (!each[:where].is_a?(Array) || each[:where].empty?)

        where = each[:where] || []
        lists = [["where", where], ["claims", each[:claims]]] #: Array[[String, Array[untyped]]]
        lists.each do |list, entries|
          entries.each_with_index do |entry, item_index|
            item_label = "#{label}.each.#{list}[#{item_index}]"
            refuse("#{item_label} must be an object with compare and expected") unless entry.is_a?(Hash)

            check_comparison(item_label, entry, shape, true, from_observe)
          end
        end
        where.each_with_index do |entry, where_index|
          next unless WHERE_DECIDES.include?(entry[:compare])

          place = item_read_path(entry)
          overlapping = each[:claims].index { overlap?(item_read_path(_1), place) }
          next if overlapping.nil?

          other = item_read_path(each[:claims][overlapping])
          relation = if other.size == place.size then "the same place"
                     elsif other.size > place.size then "a place inside it"
                     else "a place that holds it"
                     end
          refuse("#{label}.each.where[#{where_index}] selects by #{described_item(place)} with #{entry[:compare]}, and #{label}.each.claims[#{overlapping}] reads #{described_item(other)}, #{relation}, " \
                 "so where selects the items by the value the claim then judges and \"every item\" says nothing. Select by another value, or drop where")
        end
        where.each_with_index do |entry, where_index|
          literal = literal_of(entry[:expected])
          type = if ORDER_COMPARES.include?(entry[:compare]) then "number"
                 elsif entry[:compare] == "not-equal" && literal then literal_json_type(literal[:literal])
                 end
          next if type.nil?

          claim_index = each[:claims].index do |item|
            named = literal_of(item[:expected])&.dig(:literal)
            kind = named.is_a?(String) ? Claims::VALUE_KINDS.find { _1.casecmp?(named) } : nil
            item[:compare] == "is-a" && kind && KIND_JSON_TYPES[kind.to_s.downcase] == type && one_item_value?(entry, item)
          end
          next if claim_index.nil?

          kind = literal_of(each[:claims][claim_index][:expected]).to_h[:literal].to_s
          refuse("#{label}.each.where[#{where_index}] selects by #{described_item(item_path(entry))} with #{entry[:compare]}, which holds only on #{article(type)}, " \
                 "and #{label}.each.claims[#{claim_index}] claims is-a #{JSON.generate(kind)} on the same value, so every item where selects holds it, whatever the data, " \
                 "and the claim measures nothing. Claim what the value is beyond its type, or drop the claim")
        end
      end

      # The args keys observe never receives, each with the side a claim
      # reads it on: a key a claim names as its expected value (a sentence
      # key, or the head of a from path), and the from key a claim's actual
      # starts with when that claim, or an item claim under its each, takes
      # its expected value from observe. So observe cannot return what it
      # will be compared with, either way.
      #: (Array[Hash[Symbol, untyped]], Array[String]) -> Hash[String, String]
      def withheld_keys(claims, from_keys)
        keys = {} #: Hash[String, String]
        claims.each do |claim|
          entries = claim[:each] ? [*(claim[:each][:where] || []), *claim[:each][:claims]] : [claim]
          entries.each do |entry|
            expected = entry[:expected]
            if expected.is_a?(String) then keys[expected] = "expected"
            elsif expected.is_a?(Hash) && expected[:from] then keys[expected[:from].to_s.split(".").first.to_s] = "expected"
            elsif expected.is_a?(Hash) && expected.key?(:observe)
              head = claim[:actual].to_s.split(".").first.to_s
              keys[head] = "actual" if from_keys.include?(head) && !keys.key?(head)
            end
          end
        end
        keys
      end

      # An observe no claim reads changes no verdict; a key it returns under
      # a from key's name never reaches a claim, since the from value wins.
      #: (Array[Hash[Symbol, untyped]], Shape) -> void
      def check_observe_read(claims, shape)
        return unless shape.observe

        read = claims.any? do |claim|
          next true unless shape.from_keys.include?(claim[:actual].to_s.split(".").first.to_s)

          entries = claim[:each] ? [*(claim[:each][:where] || []), *claim[:each][:claims]] : [claim]
          entries.any? { _1[:expected].is_a?(Hash) && _1[:expected].key?(:observe) }
        end
        return if read

        refuse("the step has observe, and no claim reads what it returns: every claim's actual is a key of from, and no expected value is { observe }. " \
               "A key observe returns under a from key's name never reaches a claim, since the from value wins. " \
               "Rename the key observe returns so no from key has its name, or drop observe")
      end

      # A value the line states that no claim reads, in a step with no
      # observe to receive it, is a value nothing checks.
      #: (Array[Hash[Symbol, untyped]], Shape) -> void
      def check_captures_read(claims, shape)
        return if shape.observe

        read = keys_read(claims)
        unread = shape.capture_keys.find { !read.include?(_1) }
        return unless unread

        refuse(%(the pattern captures "#{unread}", and no claim reads it, and the step has no observe to receive it, so nothing checks the value the line states. ) +
               %(Compare a claim with "#{unread}", or take it out of the pattern))
      end

      # The args keys the claims read: the head of each actual path, a
      # sentence key named as an expected value, and the head of a from
      # expected path, in every claim and in each each's where and claims.
      #: (Array[Hash[Symbol, untyped]]) -> Array[String]
      def keys_read(claims)
        head = ->(path) { path.to_s.split(".").first.to_s }
        claims.flat_map do |claim|
          items = claim[:each] ? [*(claim[:each][:where] || []), *claim[:each][:claims]] : [claim]
          expected = items.map do |item|
            value = item[:expected]
            if value.is_a?(String) then value
            elsif value.is_a?(Hash) && value[:from] then head.(value[:from])
            end
          end
          [head.(claim[:actual]), *expected]
        end.compact.uniq
      end
    end
  end
end
