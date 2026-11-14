# frozen_string_literal: true

# What `check` can say without running anything: every finding follows from
# the step classes, their patterns and schemas, `Method#parameters`, and the
# feature files. The codes are the TypeScript engine's codes, so one set of
# conformance cases judges both engines.
module Nukadoko
  module Engine
    Finding = Data.define(:severity, :code, :file, :line, :step, :message, :fix) do
      def self.about_step(severity, code, step, message, fix)
        new(severity, code, step.file, step.line, step.step_name, message, fix)
      end

      def to_h = super.compact
    end

    FIXTURES = %w[baseURL call context env evidence page pageAs poll request requireEnv result].freeze

    class Check
      attr_reader :findings, :usable

      def initialize(steps, scenarios)
        @steps = steps
        @scenarios = scenarios
        @findings = []
        @usable = steps.reject { definition_broken?(_1) }
        @usable.each { check_contract(_1) }
        check_lines
      end

      def passed? = findings.none? { _1.severity == "error" }

      private

      # A step whose definition cannot stand (an unknown claim compare) is left
      # out of the vocabulary, as the TypeScript engine leaves out a step file
      # that fails to import, so it can never match a line.
      def definition_broken?(step)
        unknown = Claims.unknown_compares(step.claims || [])
        unknown.each do |compare|
          findings << Finding.about_step("error", "step-file-import-failed", step,
                                         "claims compare must be one of #{Claims::COMPARES.join(", ")}; got #{compare.inspect}.",
                                         "Correct the error that the message names in the file, then run nuka check again.")
        end
        unknown.any?
      end

      def check_contract(step)
        keys = step.args.fields.map { _1.name.to_s }
        (Pattern.new(step.pattern).keys - keys).each do |key|
          findings << Finding.about_step("error", "unknown-capture-key", step,
                                         %(Step "#{step.step_name}" pattern "#{step.pattern}" binds key "#{key}", which is not a key of its args schema),
                                         "Rename the capture to a key of the args schema, or add the key to the schema.")
        end
        (step.fixtures.map(&:to_s) - FIXTURES).each do |name|
          findings << Finding.about_step("error", "fixture-structural-violation", step,
                                         %(#{step.body}() names unknown fixture "#{name}": known fixtures are #{FIXTURES.join(", ")}),
                                         "Name a known fixture as a keyword argument.")
        end
      end

      def check_lines
        undefined = []
        @scenarios.each do |scenario|
          scenario.steps.each do |line|
            matches = Engine.matches(@usable, line.text)
            case matches.size
            when 0 then undefined << [scenario, line]
            when 1 then check_fill(scenario, line, *matches.first)
            else
              findings << Finding.new("error", "ambiguous-step", scenario.uri, line.line, nil,
                                      "#{matches.size} steps match \"#{line.text}\"", "Make the patterns distinct.")
            end
          end
        end
        suppress_undefined(undefined)
      end

      # While a step definition is broken, a line it would have matched looks
      # undefined. Saying so would send the reader after the wrong fix, so the
      # judgment waits for the broken definition, with one warning.
      def suppress_undefined(undefined)
        broken = @steps - @usable
        if broken.any? && undefined.any?
          findings << Finding.about_step("warning", "undefined-step-check-suppressed", broken.first,
                                         "Suppressed #{undefined.size} undefined-step issues because #{broken.size} step file could not be read",
                                         "Correct the step-file-import-failed error, then run nuka check again.")
          return
        end
        undefined.each do |scenario, line|
          findings << Finding.new("error", "undefined-step", scenario.uri, line.line, nil,
                                  %(No step matches "#{line.text}"), "Add a step whose pattern matches the line.")
        end
      end

      def check_fill(scenario, line, step, captures)
        missing = step.args.fields.map { _1.name.to_s } - captures.keys
        missing = missing.drop(1) if line.table && missing.any?
        missing.each do |key|
          findings << Finding.new("error", "unfillable-required-key", scenario.uri, line.line, step.step_name,
                                  %(Step "#{step.step_name}"'s args key "#{key}" is required, but nothing on this line can fill it),
                                  "Capture the key in the pattern, attach a table, or make the key optional.")
        end
      end
    end

    def self.matches(steps, text)
      steps.filter_map { |step| (captures = Pattern.new(step.pattern).match(text)) && [step, captures] }
    end
  end
end
