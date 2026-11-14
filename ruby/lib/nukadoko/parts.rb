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

      # A refused call starts nothing, so it records nothing. Every other
      # call is recorded in the order it started, with its result or its
      # error, as the TypeScript engine records it.
      def call(part, args = {}, **keywords)
        caller = @stack.last
        unless part.is_a?(Class) && part < Step && caller.parts.include?(part)
          raise Refused, %(Step "#{caller.step_name}" called "#{part.respond_to?(:step_name) ? part.step_name : part.inspect}" through call(), but does not list it in its own ) +
                         %("parts" (docs/spec.md "Parts"). Add it there. The fixture bag this step runs with is ) +
                         %(built from that list before "run" is called, so a part the list does not name has nothing to run with.)
        end

        args = args.merge(keywords).transform_keys(&:to_s)
        entry = { step: part.step_name, args: args }
        started = Time.now.utc.iso8601(3)
        @into.last << entry
        run(part, args, entry, started)
      end

      private

      def run(part, args, entry, started)
        nested = []
        fail_with = lambda do |kind, message|
          entry.merge!(error: { message: message, kind: kind }, started_at: started, finished_at: Time.now.utc.iso8601(3), **(nested.any? ? { calls: nested } : {}))
        end
        problems = part.args.problems(args)
        if problems.any?
          message = "args validation failed: #{problems.join("; ")}"
          fail_with.("args_invalid", message)
          raise TypeError, message
        end

        @stack << part
        @into << nested
        begin
          value = part.new.run(**@fixtures.slice(*part.fixtures), args: part.inputs.load(args))
        rescue StandardError => e
          fail_with.("step_error", e.message) unless entry[:error]
          raise
        ensure
          @stack.pop
          @into.pop
        end
        problems = part.returns ? part.returns.problems(value) : []
        if problems.any?
          message = "returns: #{problems.join("; ")}"
          fail_with.("result_invalid", message)
          raise TypeError, message
        end

        value = part.returns.strip(value) if part.returns
        entry.merge!(result: value, started_at: started, finished_at: Time.now.utc.iso8601(3), **(nested.any? ? { calls: nested } : {}))
        part.returns ? part.returns.load(value) : value
      end
    end
  end
end
