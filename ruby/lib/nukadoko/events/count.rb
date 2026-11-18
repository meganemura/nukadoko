# frozen_string_literal: true

# rbs_inline: enabled

module Nukadoko
  module Engine
    module Events
      # Responsibility: what a count of execution events says of a claim:
      # the range the count lies in, and whether a compare holds, breaks, or
      # cannot be known on that range, with the words of the reason. Pure.
      # Boundary: what the lines add up to is the tally's; where the
      # expected value comes from is the claim's.
      #
      # A count is a range, never one number standing for "probably that
      # many". Lines that match raise the lower bound. Lines that may match
      # raise only the upper bound, and a reading that is not whole has
      # none, since more lines may still come. A compare holds, or breaks,
      # only when it gives that answer for every count in the range, so an
      # absence never holds on a reading that was not whole.
      module Count
        COMPARES = %w[equal not-equal greater-than at-least less-than at-most].freeze

        # The gaps that say nothing was read, rather than that what was
        # read may lack lines.
        UNREAD_GAPS = %w[inlet-unnamed world-unread producer-not-run].freeze

        CAUSE_WORDS = {
          "unreadable" => ["could not be read", "could not be read"],
          "undefined_kind" => ["is of a kind the format does not define", "are of a kind the format does not define"],
          "unknown_version" => ["is of a later version", "are of a later version"],
          "field_unknown" => ["lacks a selected field or holds an invalid one", "lack a selected field or hold an invalid one"],
          "holds_unknown" => ["may be on a table the count leaves out", "may be on tables the count leaves out"],
          "commit_unknown" => ["has a commit state no line decides", "have a commit state no line decides"],
          "unowned" => ["carries no step's trace id and may be the step's", "carry no step's trace id and may be the step's"]
        }.freeze

        # The range a selection's count lies in: `[yes, yes + maybe]` on a
        # whole reading, `[yes, unbounded]` on one that is not.
        #: (Integer, Hash[String, Integer], bool) -> Hash[Symbol, Integer?]
        def self.range_of(yes, maybe, whole)
          { at_least: yes, at_most: whole ? yes + maybe_total(maybe) : nil }
        end

        #: (Hash[String, Integer]) -> Integer
        def self.maybe_total(maybe) = MAYBE_CAUSES.sum { maybe[_1].to_i }

        # What `compare` gives for every whole count in `range`.
        #: (Hash[Symbol, Integer?], String, Numeric) -> Symbol
        def self.judge_range(range, compare, expected)
          low = range[:at_least].to_i
          high = range[:at_most]
          answer = ->(holds, breaks) { holds ? :held : breaks ? :broken : :unknown }
          # A count is a whole number, so it never equals a fraction.
          within = (expected.is_a?(Integer) || (expected.is_a?(Float) && expected == expected.floor)) && expected >= low && (high.nil? || expected <= high)
          case compare
          when "equal" then answer.(within && high == low, !within)
          when "not-equal" then answer.(!within, within && high == low)
          when "greater-than" then answer.(low > expected, !high.nil? && high <= expected)
          when "at-least" then answer.(low >= expected, !high.nil? && high < expected)
          when "less-than" then answer.(!high.nil? && high < expected, low >= expected)
          else answer.(!high.nil? && high <= expected, low > expected)
          end
        end

        #: (Integer) -> String
        def self.lines(count) = count == 1 ? "1 line" : "#{count} lines"

        # The words of one gap, as a reason uses them.
        #: (Hash[Symbol, untyped]) -> String
        def self.describe_gap(gap)
          case gap[:gap]
          when "inlet-unnamed" then "the program names no {events}, so the program has no events file"
          when "world-unread" then "nukadoko did not start the world's program, so it reads no events there"
          when "producer-not-run" then "no earlier line of the scenario ran the step whose events are read"
          when "no-requests" then "the step sent the world no request with a traceparent, ran no process, and sent no MCP call"
          when "mcp-unbounded"
            if gap[:calls] == 1
              "1 MCP call of the step went to its server by a way no line reports the end of (stdio, or another origin than the world's), and the server may still work for it"
            else
              "#{gap[:calls]} MCP calls of the step went to their server by a way no line reports the end of (stdio, or another origin than the world's), and the server may still work for them"
            end
          when "processes-unbounded" then "a process the step ran may still send the world requests, and no line can say that every one reported"
          when "no-lines" then "no line carries the step's trace id"
          when "request-unreported" then gap[:requests] == 1 ? "1 of the step's requests has no request line" : "#{gap[:requests]} of the step's requests have no request line"
          when "jobs-pending"
            ids = gap[:job_ids]
            ids.size == 1 ? "job #{ids[0]} was enqueued and has not performed" : "jobs #{ids.join(", ")} were enqueued and have not performed"
          when "kind-unreported" then "the program has reported no #{gap[:kind]} line in this world"
          when "unreadable" then "#{lines(gap[:lines])} of the trace could not be read"
          when "truncated" then "the lines came to more than the record's file holds"
          else "the events file was replaced or made shorter while it was read"
          end
        end

        # The lines that may match, by cause.
        #: (Hash[String, Integer]) -> String
        def self.describe_maybe(maybe)
          MAYBE_CAUSES.select { maybe[_1].to_i.positive? }.map { "#{lines(maybe[_1])} #{CAUSE_WORDS.fetch(_1)[maybe[_1] == 1 ? 0 : 1]}" }.join(", ")
        end

        # The range in words: `exactly 2`, `between 1 and 3`, `at least 1,
        # with no upper bound`.
        #: (Hash[Symbol, Integer?]) -> String
        def self.describe_range(range)
          return "at least #{range[:at_least]}, with no upper bound" if range[:at_most].nil?

          range[:at_most] == range[:at_least] ? "exactly #{range[:at_least]}" : "between #{range[:at_least]} and #{range[:at_most]}"
        end

        # `held` or `broken` only when every count in the range gives that
        # answer; `unjudged` with the reason and the gap word otherwise.
        # `of` names the step whose events were read, in the reason.
        #: (Hash[Symbol, untyped], String, Numeric, ?String?) -> Hash[Symbol, untyped]
        def self.judge(reading, compare, expected, of = nil)
          answer = judge_range(reading[:range], compare, expected)
          return { outcome: answer } unless answer == :unknown

          first = reading[:whole] ? nil : reading[:open].first #: Hash[Symbol, untyped]?
          may = describe_maybe(reading[:maybe])
          events = of.nil? ? "the events" : "the events of #{of}"
          state = first && UNREAD_GAPS.include?(first[:gap]) ? "were not read" : "are not whole"
          why = if first then "#{events} #{state} (#{first[:gap]}): #{describe_gap(first)}"
                elsif !may.empty? then may
                else "#{events} are not whole"
                end
          shown = expected.is_a?(Float) && expected == expected.floor ? expected.to_i : expected
          { outcome: :unjudged, reason: "#{why}, so the count is #{describe_range(reading[:range])}, and #{compare} #{shown} is not known", gap: first&.[](:gap) }
        end
      end
    end
  end
end
