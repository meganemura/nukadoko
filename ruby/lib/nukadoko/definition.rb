# frozen_string_literal: true
# rbs_inline: enabled

# What the TypeScript engine's defineStep refuses when a step file loads:
# a claim or a poll that could only be judged one way, or that would let a
# line fill the value a claim measures. The Ruby engine reads the same
# declarations after loading, and check reports the first as the
# TypeScript engine does, as step-file-import-failed, so the step leaves
# the vocabulary.
module Nukadoko
  module Engine
    class Definition
      # setTimeout's own limit, which a poll's timeout cannot pass.
      MAX_TIMEOUT_MS = 2_147_483_647

      #: (singleton(Step)) -> void
      def initialize(step)
        @step = step
        @observe = step.method_defined?(:observe) #: bool
      end

      #: () -> Array[String]
      def problems
        problem = timeout_problem
        return ["#{@step.name} #{problem}."] if problem

        claims = @step.claims
        return [] unless claims

        problem = ClaimRules.first_problem(claims, shape) || poll_problem
        # Named by the class, as the TypeScript engine names its defineStep call.
        problem ? ["#{@step.name} #{problem}."] : []
      end

      private

      #: () -> ClaimRules::Shape
      def shape
        fields = @step.args.fields
        ClaimRules::Shape.new(
          patterns: @step.patterns, args_keys: fields.map { _1.name.to_s },
          string_args: fields.select { _1.type == :string }.map { _1.name.to_s },
          from_keys: @step.from.keys.map(&:to_s), capture_keys: @step.patterns.flat_map { Pattern.new(_1).keys }.uniq,
          observe: @observe
        )
      end

      # A deadline the step could never keep is refused when it loads, as
      # the TypeScript engine refuses one Node's timer would clamp.
      #: () -> String?
      def timeout_problem
        timeout = @step.timeout
        return nil if timeout.nil? || (timeout.is_a?(Integer) && timeout.positive? && timeout <= MAX_TIMEOUT_MS)

        "timeout must be a whole number of milliseconds greater than 0 and at most #{MAX_TIMEOUT_MS}; got #{ClaimRules.describe(timeout)}"
      end

      #: () -> String?
      def poll_problem
        poll = @step.poll
        return nil if poll.nil? || poll == false

        timeout = poll.is_a?(Hash) ? poll[:timeout_ms] : nil
        unless poll.is_a?(Hash) && (poll.keys - %i[timeout_ms settled]).empty? && timeout.is_a?(Numeric) && (!timeout.is_a?(Float) || timeout.finite?) && timeout.positive? && timeout <= MAX_TIMEOUT_MS
          return "poll must be false or { timeout_ms, settled? } with a number of milliseconds greater than 0 and at most #{MAX_TIMEOUT_MS}; got #{ClaimRules.describe(poll)}"
        end
        return "poll re-runs observe, and the step has no observe. Values from earlier steps do not change between readings" unless @observe

        nil
      end
    end
  end
end
