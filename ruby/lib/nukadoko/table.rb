# frozen_string_literal: true

# The run's verdict table: a row per criterion (a scenario, or an Examples
# row), a cell per environment. A cell is `required` where its environment
# meets the row's condition tags and a `control` elsewhere. Only a control
# that fails at a Then, the same way, in every proof run proves a row.
module Nukadoko
  module Engine
    module Table
      PROOF_RUNS = 2

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
      # `[:fail, line, claim]`, or `[:broke, line]`.
      def self.cell(executions)
        first = executions.first
        if executions.uniq.size > 1
          line = executions.find { _1.first != :pass }&.at(1)
          { outcome: "flaky", line: line }
        elsif first.first == :pass then { outcome: "pass" }
        else { outcome: first.first.to_s, line: first[1] }
        end.merge(runs: executions.size)
      end

      def self.verdict(cells)
        required = cells.select { _1[:role] == "required" }
        return "failed" if required.empty? || required.any? { _1[:outcome] != "pass" }

        proven = cells.any? { _1[:role] == "control" && _1[:outcome] == "fail" && _1[:runs] >= PROOF_RUNS }
        proven ? "proven" : "held"
      end

      def self.condition_tags(tags) = tags.grep(/\A@with(out)?:/)
    end
  end
end
