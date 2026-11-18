# frozen_string_literal: true
# rbs_inline: enabled

# What a count of execution events counted, grouped so a record names
# what the lines were and not only how many: the lines of one kind that
# hold the same values in the fields that tell them apart, and those
# groups in words. Pure. Which lines a count matches is Tally's.
module Nukadoko
  module Engine
    module Events
      module Counted
        # The fields a group of each kind is told apart by, in the order its
        # record and its words name them.
        GROUP_FIELDS = {
          "request" => %w[method route status], "db" => %w[op table], "tx" => %w[phase], "job" => %w[name phase],
          "http" => %w[method origin status], "flag" => %w[name side], "error" => %w[class handled]
        }.freeze #: Hash[String, Array[String]]

        OP_WORDS = { "read" => "read from", "insert" => "insert into", "update" => "update", "delete" => "delete from", "other" => "other on" }.freeze

        # How many groups a line names before it says how many lines the
        # rest hold.
        GROUPS_NAMED = 3

        # The lines a count matched, grouped as they are folded.
        class Groups
          #: (String) -> void
          def initialize(kind)
            @kind = kind
            @lines = Hash.new(0) #: Hash[String, Integer]
          end

          #: (Hash[String, untyped]) -> void
          def add(object) = @lines[Counted.key_of(@kind, object)] += 1

          # The groups of the lines added and of `more`, most lines first,
          # then by their values; `more` is not added.
          #: (?Array[Hash[String, untyped]]) -> Array[Hash[Symbol, untyped]]
          def groups(more = [])
            all = @lines.dup
            more.each { all[Counted.key_of(@kind, _1)] += 1 }
            names = GROUP_FIELDS.fetch(@kind)
            all.sort { |(left_key, left), (right_key, right)| [right, left_key] <=> [left, right_key] }.map do |key, held|
              values = JSON.parse(key)
              { kind: @kind, fields: names.each_with_index.to_h { |name, index| [name, values[index]] }, lines: held }
            end
          end
        end

        module_function

        # The values a group is told apart by, as one key. JSON of the
        # values, compared as text, as the TypeScript engine orders them.
        #: (String, Hash[untyped, untyped]) -> String
        def key_of(kind, fields)
          values = GROUP_FIELDS.fetch(kind).map { fields[_1] || fields[_1.to_sym] }
          JsJson.generate(values)
        end

        # The groups `after` holds more lines of than `before`, each with
        # how many more.
        #: (Array[Hash[Symbol, untyped]], Array[Hash[Symbol, untyped]]) -> Array[Hash[Symbol, untyped]]
        def added(before, after)
          earlier = before.to_h { ["#{_1[:kind]}#{key_of(_1[:kind], _1[:fields])}", _1[:lines]] }
          after.filter_map do |group|
            more = group[:lines] - earlier.fetch("#{group[:kind]}#{key_of(group[:kind], group[:fields])}", 0)
            group.merge(lines: more) if more.positive?
          end
        end

        #: (untyped) -> String
        def text(value) = Selection.value_text(value)

        # One group in words, by kind: `db insert into events`.
        #: (Hash[Symbol, untyped]) -> String
        def words(group)
          fields = group[:fields].transform_keys(&:to_s)
          case group[:kind]
          when "request" then "request #{text(fields["method"])} #{fields["route"].nil? ? "(no route)" : text(fields["route"])} #{text(fields["status"])}"
          when "db" then "db #{OP_WORDS[fields["op"]] || text(fields["op"])} #{text(fields["table"])}"
          when "tx" then "tx #{text(fields["phase"])}"
          when "job" then "job #{text(fields["name"])} #{text(fields["phase"])}"
          when "http" then "http #{text(fields["method"])} #{text(fields["origin"])} #{fields["status"].nil? ? "(no response)" : text(fields["status"])}"
          when "flag" then "flag #{text(fields["name"])} #{text(fields["side"])}"
          else "error #{text(fields["class"])} (#{fields["handled"] == true ? "handled" : "not handled"})"
          end
        end

        #: (Integer, bool) -> String
        def lines_text(count, more) = "#{count}#{" more" if more} #{count == 1 ? "line" : "lines"}"

        # The groups in words: `1 line: db insert into events`, `3 lines: 2
        # db insert into scores, 1 db update rankings`, and past
        # GROUPS_NAMED `..., and 4 more lines in 2 groups`.
        #: (Array[Hash[Symbol, untyped]], ?bool) -> String
        def describe(groups, more = false) = describe_groups(groups, more) { words(_1) }

        # The groups a count left out, each with what its table holds.
        #: (Array[Hash[Symbol, untyped]]) -> String
        def describe_left_out(groups) = describe_groups(groups, false) { "#{words(_1)} (#{_1[:holds]})" }

        #: (Array[Hash[Symbol, untyped]], bool) { (Hash[Symbol, untyped]) -> String } -> String
        def describe_groups(groups, more)
          return "" if groups.empty?

          named = groups.first(GROUPS_NAMED).map { |group| groups.size == 1 ? yield(group) : "#{group[:lines]} #{yield(group)}" }
          rest = groups.drop(GROUPS_NAMED)
          tail = rest.empty? ? [] : ["and #{lines_text(rest.sum { _1[:lines] }, true)} in #{rest.size} #{rest.size == 1 ? "group" : "groups"}"]
          "#{lines_text(groups.sum { _1[:lines] }, more)}: #{[*named, *tail].join(", ")}"
        end
      end
    end
  end
end
