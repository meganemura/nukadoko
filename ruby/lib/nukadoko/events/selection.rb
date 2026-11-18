# frozen_string_literal: true
# rbs_inline: enabled

# What a count over execution events selects (one kind, and for each field
# it names, the values a line must hold), the refusal of a selection the
# format cannot judge, and what one line says about one selection. Pure.
# Which lines are a trace's, and whether a line's change persisted, are
# the caller's (Tally, CommitIndex).
#
# A field a selection names is one whose value is one string, one number,
# or true or false: lists (`ids`, `calls`) are not what a count selects by.
# `committed` is not a field of the line to compare but the commit state
# the format defines, so it has a rule of its own: a db selection whose
# `op` may be a write states it, since a write that was rolled back would
# otherwise count as written, and one that selects reads alone leaves it
# out, since a read persists nothing.
#
# A line answers a selection with `yes`, `no`, or why it may match: a kind
# the format does not define, a later version, a selected field that is
# missing or invalid, or a commit state still to be decided. A definite
# `no` on any field wins over an unknown one. A writer's own kind (`x_`)
# is never one of the kinds a selection names.
#
# A selection here is a Hash with String keys, as a line's object is: the
# step's declaration is read into one with Selection.normalize.
module Nukadoko
  module Engine
    module Events
      module Selection
        # Every write whose change persisted, as "nothing was written"
        # selects them.
        PERSISTED_WRITES = { "kind" => "db", "op" => %w[insert update delete other], "committed" => true }.freeze

        VALUE_WORDS = { string: "a string", integer: "an integer", boolean: "true or false", number: "a number", strings: "a list of strings", ids: "a list of ids" }.freeze

        module_function

        # A declaration with its keys as strings, a value from the sentence
        # (`{ sentence: "table" }`) kept as `{ "sentence" => "table" }`.
        #: (untyped) -> untyped
        def normalize(value)
          case value
          when Hash then value.to_h { |key, inner| [key.to_s, normalize(inner)] }
          when Array then value.map { normalize(_1) }
          when Symbol then value.to_s
          else value
          end
        end

        #: (String, Field) -> bool
        def selectable?(name, field) = name != "committed" && %i[string integer boolean].include?(field.type)

        #: (untyped, Field) -> bool
        def fits?(value, field)
          return field.required && field.nullable if value.nil?

          case field.type
          when :string then value.is_a?(String) && (field.values.nil? || field.values&.include?(value) == true)
          when :integer then Events.safe_integer?(value)
          when :boolean then [true, false].include?(value)
          else false
          end
        end

        #: (Field) -> String
        def value_words(field)
          one = field.values ? "one of #{field.values&.join(", ")}" : VALUE_WORDS.fetch(field.type)
          field.required && field.nullable ? "#{one}, or null" : one
        end

        #: (untyped) -> bool
        def sentence_value?(value) = value.is_a?(Hash) && value.keys == ["sentence"]

        #: (untyped) -> Array[untyped]
        def values_of(value) = value.is_a?(Array) ? value : [value]

        #: (untyped) -> bool
        def reads_alone?(op)
          return false if op.nil?

          values_of(op).all? { _1 == "read" }
        end

        #: (untyped) -> String
        def shown(value) = value.nil? ? "null" : JsJson.generate(value)

        # Why `value` is not a selection the format can judge, one message
        # per problem, each starting with `where`. Empty when it is one.
        #: (untyped, String) -> Array[String]
        def problems(value, where)
          kinds = KINDS.keys.join(", ")
          return ["#{where} is not an object that names a kind and the values of its fields; name one of the kinds #{kinds}"] unless value.is_a?(Hash)

          kind = value["kind"]
          return ["#{where}.kind is missing; name one of the kinds #{kinds}"] unless kind.is_a?(String)
          if kind.start_with?(EXTENSION_PREFIX)
            return ["#{where}.kind is #{JSON.generate(kind)}, a writer's own kind, whose fields the format does not define, so a count judges no line of it; count one of the kinds #{kinds}"]
          end

          fields = KINDS[kind]
          return ["#{where}.kind is #{JSON.generate(kind)}, which the execution events format does not define; its kinds are #{kinds}"] unless fields

          names = fields.select { |name, field| selectable?(name, field) || name == "committed" }.keys
          found = [] #: Array[String]
          value.each do |name, selected|
            next if name == "kind"

            field = fields[name]
            unless field && (selectable?(name, field) || name == "committed")
              why = field.nil? ? "which kind #{kind} does not define" : "which holds a list, and a count selects by fields that hold one value"
              found << "#{where} names field #{JSON.generate(name)}, #{why}; the fields it selects by are #{names.join(", ")}"
              next
            end
            if name == "committed"
              found << "#{where}.committed is #{shown(selected)}, which is not true or false" unless [true, false].include?(selected)
              next
            end
            if selected.is_a?(Array) && selected.empty?
              found << "#{where}.#{name} is an empty list, which matches no line; name at least one value"
              next
            end
            seen = {} #: Hash[String, bool]
            values_of(selected).each do |one|
              if sentence_value?(one)
                found << %(#{where}.#{name} takes a value from the sentence with no capture name; write { sentence: "<capture>" }) unless one["sentence"].is_a?(String) && !one["sentence"].empty?
                next
              end
              unless fits?(one, field)
                found << "#{where}.#{name} is #{shown(one)}, which is not #{value_words(field)}"
                next
              end
              key = shown(one)
              found << "#{where}.#{name} names #{key} twice" if seen[key]
              seen[key] = true
            end
          end
          if kind == "db"
            reads = reads_alone?(value["op"])
            if !reads && !value.key?("committed")
              found << "#{where} selects db lines whose op may be a write and does not state committed, so a write that was rolled back would count as written; add committed: true or committed: false"
            end
            found << "#{where} states committed beside op read; a read persists nothing, so leave committed out" if reads && value.key?("committed")
          end
          found
        end

        # Each value a declared selection takes from the sentence: the field
        # that names it and the capture's name.
        #: (untyped) -> Array[Hash[Symbol, String]]
        def sentence_values(declared)
          return [] unless declared.is_a?(Hash)

          declared.flat_map do |field, selected|
            values_of(selected).filter_map { |one| { field: field, name: one["sentence"] } if sentence_value?(one) && one["sentence"].is_a?(String) }
          end
        end

        # The selection with each value from the sentence filled in by
        # `capture`, or why it is not one the format can judge.
        #: (Hash[String, untyped], ^(String) -> untyped, String) -> Hash[Symbol, untyped]
        def resolve(declared, capture, where)
          fields = KINDS.fetch(declared["kind"])
          found = [] #: Array[String]
          resolved = declared.to_h do |name, selected|
            next [name, selected] if %w[kind committed].include?(name)

            field = fields.fetch(name)
            fill = lambda do |one|
              next one unless sentence_value?(one)

              value = capture.(one["sentence"])
              found << "#{where}.#{name} takes #{value.nil? ? "undefined" : shown(value)} from the sentence's capture #{JSON.generate(one["sentence"])}, which is not #{value_words(field)}" unless fits?(value, field)
              value
            end
            [name, selected.is_a?(Array) ? selected.map(&fill) : fill.(selected)]
          end
          found.any? ? { problems: found } : { selection: resolved }
        end

        # Whether a line's value may be one of the wanted values although
        # it equals none: `table: "unknown"` names a table the writer could
        # not tell, and `op: "other"` may be an upsert.
        #: (String, String, untyped, Array[untyped]) -> bool
        def undecided?(kind, field, value, wanted)
          return false unless kind == "db"
          return value == "unknown" if field == "table"
          return value == "other" && wanted.any? { %w[insert update delete].include?(_1) } if field == "op"

          false
        end

        # What `line` says about `selection`: "yes", "no", "commit-state",
        # or a cause a count's `maybe` counts by.
        #: (Hash[String, untyped], Line) -> String
        def match(selection, line)
          return "no" if line.state == "extension"
          return "undefined_kind" if line.state == "undefined-kind"
          return "unknown_version" if line.state == "unknown-version"
          return "no" unless line.kind == selection["kind"]

          fields = KINDS.fetch(line.kind.to_s)
          object = line.object || {}
          unknown = false
          selection.each do |name, selected|
            next if %w[kind committed].include?(name)

            field = fields.fetch(name)
            wanted = values_of(selected)
            value = object[name]
            if !object.key?(name) || !fits?(value, field)
              unknown = true
              next
            end
            next if wanted.include?(value)

            if undecided?(line.kind.to_s, name, value, wanted)
              unknown = true
              next
            end
            return "no"
          end
          return "field_unknown" if unknown

          selection.key?("committed") ? "commit-state" : "yes"
        end

        # A value as a label names it: a word of letters, digits, and
        # `_:/.@-` as it is, any other value as JSON, and a value from the
        # sentence as `sentence:<capture>`.
        #: (untyped) -> String
        def value_text(value)
          return "sentence:#{value["sentence"]}" if sentence_value?(value)

          value.is_a?(String) && value.match?(%r{\A[\w:/.@-]+\z}) ? value : shown(value)
        end

        # The selection in the words a record's label and a summary use:
        # `db where op in [insert, update, delete, other], committed true`.
        #: (Hash[String, untyped]) -> String
        def describe(selection)
          parts = KINDS.fetch(selection["kind"]).keys.filter_map do |name|
            next unless selection.key?(name)

            value = selection[name]
            value.is_a?(Array) ? "#{name} in [#{value.map { value_text(_1) }.join(", ")}]" : "#{name} #{value_text(value)}"
          end
          parts.empty? ? selection["kind"].to_s : "#{selection["kind"]} where #{parts.join(", ")}"
        end
      end
    end
  end
end
