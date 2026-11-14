# frozen_string_literal: true
# rbs_inline: enabled

# What the TypeScript engine's defineStep refuses when a step file loads:
# a claim or a poll that could only be judged one way, or that would let a
# line fill the value a claim measures. The Ruby engine reads the same
# declarations after loading, and check reports each as the TypeScript
# engine does, as step-file-import-failed, so the step leaves the vocabulary.
module Nukadoko
  module Engine
    class Definition
      def initialize(step)
        @step = step
        @from = step.from.keys
        @captures = step.pattern ? Pattern.new(step.pattern).keys : []
        @args = step.args.fields.map { _1.name.to_s }
        @observe = step.method_defined?(:observe)
      end

      def problems
        return [] unless @step.claims

        claim_problems + poll_problems
      end

      private

      def claim_problems
        @step.claims.each_with_index.flat_map do |claim, i|
          label = "claims[#{i}]"
          actual_problems(label, claim) + expected_problems(label, claim)
        end
      end

      def actual_problems(label, claim)
        head = claim[:actual].to_s.split(".").first
        from = @from.include?(head)
        if !from && !@observe
          [%(#{label}.actual starts with "#{head}", which is not a key of this step's from, and the step has no observe to read it)]
        elsif from && @captures.include?(head)
          [%(#{label}.actual starts with "#{head}", which a pattern captures, so a line would fill the value the claim measures. Take it out of the pattern, so an earlier step fills it)]
        elsif !from && @args.include?(head)
          [%(#{label}.actual starts with "#{head}", an args key the sentence fills. A claim's actual is a value an earlier step returned (a from key) or one observe read)]
        else []
        end
      end

      def expected_problems(label, claim)
        key = claim[:expected].is_a?(Hash) && claim[:expected][:from]&.to_s&.split(".")&.first
        return [] unless key
        return [%(#{label}.expected.from starts with "#{key}", which is not a key of this step's from)] unless @from.include?(key)
        return [%(#{label}.expected.from starts with "#{key}", which a pattern captures, so a line fills it and no earlier step does)] if @captures.include?(key)

        []
      end

      def poll_problems
        poll = @step.poll
        return [] if poll.nil? || poll == false
        unless poll.is_a?(Hash) && (poll.keys - %i[timeout_ms settled]).empty? && poll[:timeout_ms].is_a?(Numeric) && poll[:timeout_ms].positive?
          return ["poll must be false or { timeout_ms, settled? } with a number of milliseconds greater than 0; got #{poll.inspect}"]
        end
        return ["poll re-runs observe, and the step has no observe. Values from earlier steps do not change between readings"] unless @observe

        []
      end
    end
  end
end
