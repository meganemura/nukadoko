# frozen_string_literal: true

require "time"

# The `call` fixture: a step runs one of the parts it declares, with args it
# supplies itself (a call never reads `from`). The part's args and returns
# are checked as a scenario line's are, and each call lands under `calls` in
# the calling step's record, nested when a part calls a part of its own.
module Nukadoko
  module Engine
    class Caller
      # Raised for a call the declaration does not allow, so the step fails
      # as broken rather than as a claim that did not hold.
      class Refused < StandardError; end

      attr_reader :calls

      def initialize(step, fixtures)
        @fixtures = fixtures
        @stack = [step]
        @calls = []
        @into = [@calls]
      end

      def to_proc = method(:call).to_proc

      def call(part, args = {}, **keywords)
        caller = @stack.last
        unless part.is_a?(Class) && part < Step && caller.parts.include?(part)
          raise Refused, "#{caller.step_name} calls #{part.respond_to?(:step_name) ? part.step_name : part.inspect}, which its parts do not declare"
        end

        args = args.merge(keywords).transform_keys(&:to_s)
        entry = { part: part.step_name, args: args, started_at: Time.now.utc.iso8601(3) }
        @into.last << entry
        run(part, args, entry)
      ensure
        entry[:finished_at] = Time.now.utc.iso8601(3) if entry
      end

      private

      def run(part, args, entry)
        problems = part.args.problems(args)
        raise TypeError, "args of #{part.step_name}: #{problems.join("; ")}" if problems.any?

        @stack << part
        @into << (entry[:calls] = [])
        value = part.new.run(**@fixtures.slice(*part.fixtures), args: part.inputs.load(args))
        problems = part.returns ? part.returns.problems(value) : []
        raise TypeError, "returns of #{part.step_name}: #{problems.join("; ")}" if problems.any?

        entry[:result] = value
        part.returns ? part.returns.load(value.transform_keys(&:to_s)) : value
      rescue StandardError => e
        entry[:error] ||= "#{e.class}: #{e.message}"
        raise
      ensure
        if @stack.last == part
          @stack.pop
          @into.pop
          entry.delete(:calls) if entry[:calls]&.empty?
        end
      end
    end
  end
end
