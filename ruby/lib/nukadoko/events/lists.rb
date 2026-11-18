# frozen_string_literal: true
# rbs_inline: enabled

require "json"

# Responsibility: the lists a program prints of the places it has
# (docs/spec.md "Lists"): its routes, its flags, and its tables, one JSON
# object per line, each place named in the words the execution events use
# (a request line's `method` and `route`, a flag line's `name` and `side`,
# a db line's `table`), so a list joins with the lines by text alone. As
# data: every kind and its fields, and the one function that turns what a
# list command printed into the kind's entries or the reason it is not a
# list. Pure. Boundary: running the command is program.rb's, and what a
# run reads against a list is run.rb's and place_rows.rb's.
#
# A list is read whole or not at all. Read in part, it would leave out what
# a line it could not read named, and a request to that route would then
# read as one the list does not name, with nothing to say why. So one line
# that is not one entry of the kind, with a key the kind does not have, a
# value of the wrong type, or a method that is not uppercase (a request
# line's method is), makes the whole list unread, naming the line.
#
# A list is a set: an entry printed twice is one entry. A route printed
# twice with two handlers keeps both, and a flag printed twice keeps every
# side either line declares. A table printed twice with two different
# holdings is refused, naming both lines: what a table holds decides
# whether a count counts a write to it, so neither line can win.

module Nukadoko
  module Engine
    module Events
      # Every kind, in the order a world reads them.
      LIST_KINDS = %w[routes flags tables].freeze

      module Lists
        TEXT = lambda do |value|
          next "is not a string" unless value.is_a?(String)

          value.empty? ? "is empty" : nil
        end #: ^(untyped) -> String?
        METHOD = lambda do |value|
          problem = TEXT.(value)
          next problem if problem

          value == value.upcase ? nil : "is #{JSON.generate(value)}, which is not uppercase, as a request line's method is"
        end #: ^(untyped) -> String?
        HOLDS = ->(value) { TABLE_HOLDS.include?(value) ? nil : "is #{JSON.generate(value)}, which is not one of #{TABLE_HOLDS.join(", ")}" } #: ^(untyped) -> String?
        SIDES = lambda do |value|
          next "is not an array of strings" unless value.is_a?(Array) && value.all?(String)
          next "is empty" if value.empty?

          value.include?("") ? "holds an empty side" : nil
        end #: ^(untyped) -> String?

        # Every kind of list and the fields its lines hold, each with
        # whether it is required and why a value cannot be it. A key that is
        # not one of them, and does not start with `x_`, is refused, so a
        # misspelt optional field is not read as absent.
        FIELDS = {
          "routes" => { "method" => [true, METHOD], "route" => [true, TEXT], "handler" => [false, TEXT] },
          "flags" => { "name" => [true, TEXT], "sides" => [true, SIDES] },
          "tables" => { "table" => [true, TEXT], "holds" => [false, HOLDS] }
        }.freeze #: Hash[String, Hash[String, [bool, ^(untyped) -> String?]]]

        module_function

        # What a list command of `kind` printed, as the kind's entries
        # (`{ entries: }`), or why it is not a list (`{ problem: }`). A line
        # of whitespace alone holds no entry, so a blank line at the end, or
        # a CR before each line feed, reads as nothing.
        #: (String, String) -> Hash[Symbol, untyped]
        def parse(kind, output)
          lines = [] #: Array[[Hash[String, untyped], Integer]]
          output.split("\n", -1).each_with_index do |text, index|
            next if text.strip.empty?

            read = line(kind, text.delete_suffix("\r"), index + 1)
            return read if read.key?(:problem)

            lines << [read[:line], index + 1]
          end
          collect(kind, lines)
        end

        # Line `number` of the output as an entry of `kind`, or why it is
        # not one.
        #: (String, String, Integer) -> Hash[Symbol, untyped]
        def line(kind, text, number)
          value = begin
            JSON.parse(text)
          rescue JSON::ParserError
            return { problem: "line #{number} is not JSON" }
          end
          return { problem: "line #{number} is not one JSON object" } unless value.is_a?(Hash)

          repeated = Events.repeated_key(text)
          return { problem: "line #{number} holds the key #{JSON.generate(repeated)} twice" } if repeated

          fields = FIELDS.fetch(kind)
          value.each_key do |key|
            next if fields.key?(key) || key.start_with?(EXTENSION_PREFIX)

            return { problem: "line #{number} has the key #{JSON.generate(key)}, which a #{kind} line does not have " \
                              "(#{fields.keys.join(", ")}, or an #{EXTENSION_PREFIX} key of the program's own)" }
          end
          fields.each do |name, (required, problem_of)|
            unless value.key?(name)
              return { problem: "line #{number} has no #{name}" } if required

              next
            end
            problem = problem_of.(value[name])
            return { problem: "line #{number}'s #{name} #{problem}" } if problem
          end
          { line: value }
        end

        # What a kind's checked lines come to, merged per place, or why they
        # are not one list.
        #: (String, Array[[Hash[String, untyped], Integer]]) -> Hash[Symbol, untyped]
        def collect(kind, lines)
          case kind
          when "routes"
            routes = {} #: Hash[[String, String], Hash[Symbol, untyped]]
            lines.each do |line, _|
              entry = routes[[line["method"], line["route"]]] ||= { method: line["method"], route: line["route"], handlers: [] }
              entry[:handlers] |= [line["handler"]] if line["handler"].is_a?(String)
            end
            { entries: routes.values.map { _1.merge(handlers: _1[:handlers].sort) } }
          when "flags"
            flags = {} #: Hash[String, Array[String]]
            lines.each { |line, _| flags[line["name"]] = (flags[line["name"]] || []) | line["sides"] }
            { entries: flags.map { { name: _1, sides: _2 } } }
          else
            tables = {} #: Hash[String, [String, Integer]]
            lines.each do |line, number|
              holds = line["holds"] || "state"
              earlier = tables[line["table"]]
              if earlier.nil? then tables[line["table"]] = [holds, number]
              elsif earlier.first != holds
                return { problem: "line #{number} says table #{JSON.generate(line["table"])} holds #{holds}, and line #{earlier.last} says it holds #{earlier.first}" }
              end
            end
            { entries: tables.map { { table: _1, holds: _2.first } } }
          end
        end

        # A read tables list, as a count reads it: the tables it marks.
        #: (Array[Hash[Symbol, untyped]]) -> Hash[Symbol, untyped]
        def tables_of(entries) = { marked: entries.reject { _1[:holds] == "state" }.to_h { [_1[:table], _1[:holds]] } }
      end
    end
  end
end
