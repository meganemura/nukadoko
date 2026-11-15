# frozen_string_literal: true
# rbs_inline: enabled

require "time"

# `poll timeout_ms: 3000` reads `observe` again, 100 ms apart, until every
# claim holds on two consecutive readings or the timeout passes. One holding
# reading is never enough: a page between two renders can show the expected
# state for one frame. `settled:` names a state that cannot change once
# reached, so two consecutive settled readings stop the wait for a claim
# that broke on it. The last reading is what the step judges, and every
# reading lands in the step record, because an observe that counts its
# calls could walk toward the expected value.
module Nukadoko
  module Engine
    class Poll
      INTERVAL = 0.1

      #: (Hash[Symbol, untyped], Array[Hash[Symbol, untyped]], Hash[Symbol, untyped]) -> void
      def initialize(options, claims, args)
        @timeout = options.fetch(:timeout_ms) / 1000.0
        @settled = options[:settled] || []
        @claims = claims
        @args = args
      end

      # A reading whose observe raised is kept with the first line of the
      # error, and the poll reads again; only a last reading that raised
      # fails the step with that error.
      #: (Hash[Symbol, untyped]) { () -> untyped } -> untyped
      def call(record)
        deadline = monotonic + @timeout
        readings = []
        stop = nil
        begin
          loop do
            readings << read(readings.size + 1) { yield }
            stop = stop_for(readings)
            break if stop || monotonic + INTERVAL > deadline

            sleep INTERVAL
          end
        ensure
          record[:readings] = readings.map { _1.except(:value, :raised, :judged_now) }
          record[:poll] = { readings: readings.size, stop: stop || "timeout", conditions: @settled.map { RunRecord.describe_comparison(_1) } }
        end
        raise readings.last[:raised] if readings.last[:raised]

        readings.last[:value]
      end

      private

      #: (Integer) { () -> untyped } -> Hash[Symbol, untyped]
      def read(attempt)
        judge(yield, attempt)
      rescue StandardError => e
        { attempt: attempt, at: Time.now.utc.iso8601(3), holds: false, error: "#{e.class}: #{e.message.lines.first&.chomp}", raised: e }
      end

      #: (untyped, Integer) -> Hash[Symbol, untyped]
      def judge(value, attempt)
        judged = Claims.judge(@claims, value, @args)
        reading = { attempt: attempt, at: Time.now.utc.iso8601(3), holds: judged.all? { _1[:holds] }, actuals: judged.map { _1[:actual] }, value: value,
                    judged_now: judged.select { _1[:for_judgment] }.map { _1[:actual] } }
        reading[:settled] = @settled.all? { Claims.judge_one(_1, value, {})[:holds] } if @settled.any?
        reading
      end

      #: (Array[Hash[Symbol, untyped]]) -> String?
      def stop_for(readings)
        before = readings[-2] or return nil
        last = readings.last #: Hash[Symbol, untyped]
        # A value read for a judgment holds a poll only once two readings
        # read it the same: a judge judges the last reading, and a page
        # still changing would hand them a frame it then left.
        return "held" if last[:holds] && before[:holds] && last[:judged_now] == before[:judged_now]

        "settled" if last[:settled] && before[:settled]
      end

      #: () -> Float
      def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end
  end
end
