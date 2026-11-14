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

    FIXTURES = %w[baseURL call context env evidence page pageAs poll request requireEnv result scratch].freeze

    class Check
      attr_reader :findings, :usable

      def initialize(steps, scenarios)
        @steps = steps
        @scenarios = scenarios
        @findings = []
        @usable = steps.reject { definition_broken?(_1) }
        @usable.each { check_contract(_1) }
        check_parts
        check_shapes
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
        (step.pattern ? Pattern.new(step.pattern).keys - keys : []).each do |key|
          findings << Finding.about_step("error", "unknown-capture-key", step,
                                         %(Step "#{step.step_name}" pattern "#{step.pattern}" binds key "#{key}", which is not a key of its args schema),
                                         "Rename the capture to a key of the args schema, or add the key to the schema.")
        end
        undescribed = [step.args, step.returns].compact.flat_map(&:fields).reject(&:description)
        if undescribed.any?
          findings << Finding.about_step("note", "schema-field-undescribed", step,
                                         "Step \"#{step.step_name}\" has schema fields with no description: #{undescribed.map(&:name).join(", ")}",
                                         "Give each field a description, so nuka steps and an agent can say what it means.")
        end
        known = FIXTURES + Nukadoko.project_fixtures.keys.map(&:to_s)
        (step.fixtures.map(&:to_s) - known).each do |name|
          findings << Finding.about_step("error", "fixture-structural-violation", step,
                                         %(#{step.body}() names unknown fixture "#{name}": known fixtures are #{known.uniq.sort.join(", ")}),
                                         "Name a known fixture as a keyword argument.")
        end
      end

      # A cycle never closes into a fixture bag, and a read-only step cannot
      # reach a part that writes: both can only end one way, so both are errors.
      def check_parts
        @usable.each do |step|
          step.parts.reject { _1.is_a?(Class) && _1 < Step && @steps.include?(_1) }.each do |part|
            findings << Finding.about_step("error", "part-structural-violation", step,
                                           "Step \"#{step.step_name}\" declares #{part.inspect} as a part, which is not a registered step",
                                           "Make each parts entry a step that a step file registers.")
          end
          step.parts.select { step.mutates == false && _1.respond_to?(:mutates) && _1.mutates == true }.each do |part|
            findings << Finding.about_step("error", "part-mutates-contradiction", step,
                                           "Step \"#{step.step_name}\" declares mutates: false, but its part \"#{part.step_name}\" declares mutates: true",
                                           "Declare mutates: true on the step, or remove the part that declares mutates: true.")
          end
        end
        part_cycles.each do |cycle|
          findings << Finding.about_step("error", "part-cycle", cycle.first,
                                         "part cycle: #{cycle.map(&:step_name).join(" -> ")}",
                                         "Remove one part from the chain, so that no step reaches itself.")
        end
      end

      # Each cycle once, named from the step whose walk first closed it.
      def part_cycles
        done = []
        cycles = []
        visit = lambda do |step, stack|
          stack += [step]
          step.parts.each do |part|
            next unless @steps.include?(part)

            if stack.include?(part) then cycles << stack.drop(stack.index(part)) + [part]
            elsif !done.include?(part) then visit.(part, stack)
            end
          end
          done << step
        end
        @usable.each { visit.(_1, []) unless done.include?(_1) }
        cycles
      end

      # A scenario with steps of its own and no Then can never be judged on
      # an outcome. The Background's steps count toward the Then.
      def check_shapes
        @scenarios.uniq { [_1.uri, _1.keyword_line] }.each do |scenario|
          next if scenario.steps.all?(&:background) || scenario.steps.any? { _1.kind == "Outcome" }

          findings << Finding.new("warning", "scenario-without-then", scenario.uri, scenario.keyword_line, nil,
                                  %(Scenario "#{scenario.name}" has no Then step, so nothing about its outcome is judged),
                                  "Add a Then step that states the outcome.")
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
        missing = step.args.fields.map { _1.name.to_s } - captures.keys - step.from.keys
        missing = missing.drop(1) if (line.table || line.doc_string) && missing.any?
        missing.each do |key|
          findings << Finding.new("error", "unfillable-required-key", scenario.uri, line.line, step.step_name,
                                  %(Step "#{step.step_name}"'s args key "#{key}" is required, but nothing on this line can fill it),
                                  "Capture the key in the pattern, attach a table, or make the key optional.")
        end
      end
    end

    def self.matches(steps, text)
      steps.filter_map { |step| step.pattern && (captures = Pattern.new(step.pattern).match(text)) && [step, captures] }
    end
  end
end
