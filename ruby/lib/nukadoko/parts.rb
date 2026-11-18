# frozen_string_literal: true
# rbs_inline: enabled

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

      #: (singleton(Nukadoko::Step), Hash[Symbol, untyped], ?refuse: ^(untyped) -> String?) -> void
      def initialize(step, fixtures, refuse: ->(_) {})
        @fixtures = fixtures
        # Why a part may not run here: a part that mutates in a read-only
        # environment is refused as its caller would be.
        @refuse = refuse
        @stack = [step]
        @calls = []
        @into = [@calls]
      end


      #: () -> Proc
      def to_proc = method(:call).to_proc

      # A refused call starts nothing, so it records nothing. Every other
      # call is recorded in the order it started, with its result or its
      # error, as the TypeScript engine records it.
      #: (singleton(Nukadoko::Step), ?Hash[String | Symbol, untyped], **untyped) -> untyped
      def call(part, args = {}, **keywords)
        caller = @stack.last
        unless part.is_a?(Class) && part < Step && caller.parts.include?(part)
          raise Refused, %(Step "#{caller.step_name}" called "#{part.respond_to?(:step_name) ? part.step_name : part.inspect}" through call(), but does not list it in its own ) +
                         %("parts" (docs/spec.md "Parts"). Add it there. The fixture bag this step runs with is ) +
                         %(built from that list before "run" is called, so a part the list does not name has nothing to run with.)
        end

        refused = @refuse.(part)
        raise Refused, refused if refused

        args = args.merge(keywords).transform_keys(&:to_s)
        entry = { step: part.step_name, args: args }
        started = Time.now.utc.iso8601(3)
        @into.last << entry
        run(part, args, entry, started)
      end

      private

      #: (untyped, Hash[String, untyped], Hash[Symbol, untyped], String) -> untyped
      def run(part, args, entry, started)
        nested = []
        fail_with = lambda do |kind, message|
          entry.merge!(error: { message: message, kind: kind }, started_at: started, finished_at: Time.now.utc.iso8601(3), **(nested.any? ? { calls: nested } : {}))
        end
        problems = part.args.problems(args, strict: true)
        if problems.any?
          message = "args validation failed: #{problems.join("; ")}"
          fail_with.("args_invalid", message)
          raise TypeError, message
        end

        @stack << part
        @into << nested
        begin
          value = part.new.run(**part.keywords(@fixtures.slice(*part.fixtures), part.inputs.load(args)))
        rescue StandardError => e
          fail_with.("step_error", e.message) unless entry[:error]
          raise
        ensure
          @stack.pop
          @into.pop
        end
        value, problems = part.returned(value)
        if problems.any?
          message = "returns validation failed: #{problems.join("; ")}"
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
