# frozen_string_literal: true
# rbs_inline: enabled

# The run's verdict table: a row per criterion (a scenario, or an Examples
# row), a cell per environment. A cell is `required` where its environment
# meets the row's condition tags and a `control` elsewhere. Only a control
# that fails at a Then, the same way, in every proof run proves a row.
module Nukadoko
  module Engine
    module Table
      PROOF_RUNS = 2

      # A run's --proof-runs, read by every judgment of the one run this
      # process makes.
      class << self
        #: (Integer) -> Integer
        def proof_runs=(count)
          @proof_runs = count
        end

        #: () -> Integer
        def proof_runs = @proof_runs || PROOF_RUNS
      end

      #: (Array[String], Hash[String, untyped]) -> String
      def self.role(tags, conditions)
        meets = tags.all? do |tag|
          case tag
          when /\A@with:([\w.-]+)=(\S+)\z/ then conditions[Regexp.last_match(1)].to_s == Regexp.last_match(2)
          when /\A@with:([\w.-]+)\z/ then ![nil, false].include?(conditions[Regexp.last_match(1)])
          when /\A@without:([\w.-]+)\z/ then [nil, false].include?(conditions[Regexp.last_match(1)])
          else true
          end
        end
        meets ? "required" : "control"
      end

      # What a cell's executions came to. An execution is `[:pass]`,
      # `[:fail, line, claim]`, `[:broke, line]`, or `[:stopped, line]`
      # for a walk a person stopped after that line.
      #: (Array[Array[untyped]]) -> Hash[Symbol, untyped]
      def self.cell(executions)
        first = executions.first
        return { outcome: "not-run", runs: 0 } if first.nil?

        if executions.uniq.size > 1
          line = executions.find { _1.first != :pass }&.at(1)
          { outcome: "flaky", line: line }
        elsif first.first == :pass then { outcome: "pass" }
        else { outcome: first.first.to_s, line: first[1] }
        end.merge(runs: executions.size)
      end

      #: (Array[Hash[Symbol, untyped]]) -> String
      def self.verdict(cells)
        required = cells.select { _1[:role] == "required" }
        return "failed" if required.empty? || required.any? { _1[:outcome] != "pass" }

        proven = cells.any? { _1[:role] == "control" && _1[:outcome] == "fail" && _1[:runs] >= proof_runs }
        proven ? "proven" : "held"
      end

      #: (Array[String]) -> Array[String]
      def self.condition_tags(tags) = tags.grep(/\A@with(out)?:/)

      # The tags a row lists: its condition tags and @held, as written.
      #: (Array[String]) -> Array[String]
      def self.row_tags(tags) = [*condition_tags(tags), *(tags.include?("@held") ? ["@held"] : [])]

      # For each condition the tags name, the value the environment declares
      # for it, or nil: what a cell's role came from.
      #: (Array[String], Hash[String, untyped]) -> Hash[String, untyped]
      def self.conditions_of(tags, conditions)
        names = condition_tags(tags).map { _1[/\A@with(?:out)?:([\w.-]+)/, 1].to_s }.uniq
        names.to_h { [_1, conditions.fetch(_1, nil)] }
      end
    end
  end
end
