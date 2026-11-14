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

      def initialize(steps, scenarios, features: true, full: false, conditions: nil)
        @steps = steps
        @scenarios = scenarios
        @findings = []
        # With no step file no line can ever match, so every line would read
        # as undefined; one finding says why instead.
        if !features
          @findings << Finding.new("error", "features-dir-missing", "nukadoko.config.rb", nil, nil, %(featuresDir "features" does not exist),
                                   "Create features/steps for the step files, or correct featuresDir in nukadoko.config.rb.")
        elsif steps.empty?
          @findings << Finding.new("error", "no-step-files-found", "features", nil, nil,
                                   %(no .rb step file was found while scanning "features"; no step can ever be registered), Codes.fix("no-step-files-found"))
        end
        @usable = steps.reject { definition_broken?(_1) }
        @usable.each { check_contract(_1) }
        check_duplicate_patterns
        check_parts
        check_shapes
        check_tags(conditions)
        check_lines
        check_unbound if full
        @findings = @findings.uniq { [_1.code, _1.file, _1.line, _1.message] }
      end

      def passed? = findings.none? { _1.severity == "error" }

      private

      # A step whose definition cannot stand (an unknown claim compare) is left
      # out of the vocabulary, as the TypeScript engine leaves out a step file
      # that fails to import, so it can never match a line.
      def definition_broken?(step)
        if (pattern = pattern_problem(step))
          findings << Finding.new("error", pattern[0], step.file, nil, step.step_name, pattern[1], Codes.fix(pattern[0]))
          return true
        end
        problems = Claims.unknown_compares(step.claims || []).map { "claims compare must be one of #{Claims::COMPARES.join(", ")}; got #{_1.inspect}." }
        problems += Definition.new(step).problems
        problems.each do |problem|
          findings << Finding.about_step("error", "step-file-import-failed", step, problem,
                                         "Correct the error that the message names in the file, then run nuka check again.")
        end
        problems.any?
      end

      KEY = /\A[A-Za-z_][A-Za-z0-9_]*\z/

      # Why the step's pattern cannot be read, as the TypeScript engine says
      # it: the first broken capture, then what cucumber-expressions refuses.
      def pattern_problem(step)
        pattern = step.pattern or return nil
        head = %(Step "#{step.step_name}" pattern "#{pattern}")
        keys = []
        rest = pattern.gsub(/\./, "")
        open = rest.index("{")
        while open
          close = rest.index("}", open)
          return ["unterminated-capture", %(#{head}: Pattern has an unterminated "{" starting at: #{rest[open..]})] unless close

          token = rest[open + 1...close]
          key, type = token.split(":", 2)
          return ["unnamed-capture", %(#{head}: Parameter "{#{token}}" has no name; every parameter in a pattern must be written {key:type} (docs/spec.md "Typed steps"))] unless type
          return ["invalid-capture-key", %(#{head}: Parameter "{#{token}}" has an invalid name "#{key}": must match [a-zA-Z_][a-zA-Z0-9_]*)] unless key.match?(KEY)

          keys << key
          open = rest.index("{", close)
        end
        repeated = keys.tally.select { _2 > 1 }.keys.first
        return ["duplicate-capture-key", %(#{head} binds key "#{repeated}" more than once)] if repeated

        Pattern.new(pattern)
        nil
      rescue Cucumber::CucumberExpressions::UndefinedParameterTypeError => e
        types = Pattern::REGISTRY.parameter_types.map(&:name).reject(&:empty?).sort
        ["unknown-parameter-type", "#{head}: #{e.message} This project's registered parameter types are: #{types.join(", ")}."]
      rescue StandardError => e
        ["pattern-syntax-error", "#{head}: #{e.message}"]
      end

      NUMBER_TYPES = %w[int float bigdecimal biginteger byte short long double].freeze
      STRING_TYPES = %w[string word].freeze

      # A capture hands the step a number or a string, and an args field of
      # the other kind can never hold it.
      def capture_mismatches(step)
        fields = step.args.fields.to_h { [_1.name.to_s, _1.type] }
        step.pattern.to_s.scan(Pattern::NAMED).filter_map do |key, type|
          declared = fields[key]
          captured = if NUMBER_TYPES.include?(type) then "number"
                     elsif STRING_TYPES.include?(type) then "string"
                     end
          held = case declared
                 when :string, Array then declared == :string || declared.first == :enum ? "string" : nil
                 when :number, :integer then "number"
                 when :boolean then "boolean"
                 end
          next unless captured && held && captured != held

          [key, type, captured, held]
        end
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
        capture_mismatches(step).each do |key, type, captured, held|
          findings << Finding.new("error", "capture-type-mismatch", step.file, nil, step.step_name,
                                  %(Step "#{step.step_name}" pattern "#{step.pattern}" binds key "#{key}" as {#{type}} (a #{captured}), but args declares "#{key}" as a #{held}),
                                  "Make the capture type and the args field type agree: change the {key:type} in the pattern, or declare the field with the type the capture gives.")
        end
        known = FIXTURES + Nukadoko.project_fixtures.keys.map(&:to_s)
        (step.fixtures.map(&:to_s) - known).each do |name|
          findings << Finding.about_step("error", "fixture-structural-violation", step,
                                         %(#{step.body}() names unknown fixture "#{name}": known fixtures are #{known.uniq.sort.join(", ")}),
                                         "Name a known fixture as a keyword argument.")
        end
      end

      # Two patterns that read the same once their names go would match the
      # same lines; the later file is named, with every step that shares it.
      def check_duplicate_patterns
        @usable.select(&:pattern).group_by { _1.pattern.gsub(Pattern::NAMED) { "{#{Regexp.last_match(2)}}" } }.each do |text, group|
          next if group.size < 2

          sorted = group.sort_by(&:file)
          findings << Finding.new("error", "duplicate-pattern", sorted.last.file, nil, nil,
                                  %(Multiple patterns normalize to the same text "#{text}": #{sorted.map { %(#{_1.step_name} ("#{_1.pattern}")) }.join(", ")}),
                                  Codes.fix("duplicate-pattern"))
        end
      end

      # A pattern no line binds alone has no place in a scenario; a placeholder
      # description is what a person picking a step would read.
      def check_unbound
        bound = @scenarios.flat_map(&:steps).filter_map { |line| (m = Engine.matches(@usable, line.text)).size == 1 ? m.first.first : nil }
        # A step whose file failed to load is out of the vocabulary, so it is not unbound either.
        unread = findings.select { _1.code == "step-file-import-failed" }.map(&:step)
        @steps.select(&:pattern).reject { bound.include?(_1) || unread.include?(_1.step_name) }.sort_by(&:file).each do |step|
          findings << Finding.new("note", "pattern-unbound", step.file, nil, step.step_name,
                                  %(Step "#{step.step_name}" declares a pattern, but no feature line under the scanned directories (features) binds it. It has no place in any scenario right now.),
                                  Codes.fix("pattern-unbound"))
        end
        @usable.select { _1.description.to_s == "TODO: describe #{_1.step_name}" }.sort_by(&:file).each do |step|
          findings << Finding.new("note", "step-description-todo", step.file, nil, step.step_name,
                                  %(Step "#{step.step_name}" still has the description nuka scaffold wrote ("#{step.description}"); nuka steps and nuka describe show it to whoever picks a step, so say what the step does.),
                                  Codes.fix("step-description-todo"))
        end
      end

      CONDITION_NAME = /\A[A-Za-z0-9_.-]+\z/
      CONDITION_VALUE = /\A[^\s@]+\z/

      # The condition a tag names, nil for one that does not read.
      def self.condition_of(tag)
        if tag.start_with?("@without:")
          name = tag.delete_prefix("@without:")
          return name.match?(CONDITION_NAME) ? name : nil
        end
        name, value = tag.delete_prefix("@with:").split("=", 2)
        return nil unless name&.match?(CONDITION_NAME)
        return name if value.nil?

        value.match?(CONDITION_VALUE) && !%w[true false].include?(value) ? name : nil
      end

      EXPECTED = { "status" => [/\A5[0-9]{2}\z/, "<500-599>", "a status from 500 to 599"],
                   "error" => [CONDITION_VALUE, "<class>", "the class of an error the program reports with handled: false"],
                   "page-error" => [CONDITION_VALUE, "<name>", "the name of an error the page threw, such as TypeError"] }.freeze
      EXPECTS_FORMS = "@expects:status=<500-599>, @expects:error=<class>, or @expects:page-error=<name>"

      # Why an @expects: tag accepts nothing, nil for one that reads.
      def self.expects_problem(tag)
        kind, value = tag.delete_prefix("@expects:").split("=", 2)
        rule = EXPECTED[kind]
        return "#{tag} does not read as #{EXPECTS_FORMS}, so it accepts nothing" unless rule
        return "#{tag} names no value, and an @expects tag names what it accepts: #{rule[2]}" if value.nil? || value.empty?
        return nil if value.match?(rule[0])

        "#{tag} does not name #{rule[2]}, so it accepts nothing#{": a run judges no other status, and one tag names one status" if kind == "status"}"
      end

      def check_tags(conditions)
        @scenarios.flat_map { |scenario| scenario.tag_lines.map { |tag, line| [scenario.uri, line, tag] } }.uniq.each do |uri, line, tag|
          if tag.start_with?("@expects:")
            problem = Check.expects_problem(tag)
            findings << Finding.new("error", "expects-tag-malformed", uri, line, nil, problem, Codes.fix("expects-tag-malformed")) if problem
            next
          end
          next unless tag.start_with?("@with:", "@without:")

          name = Check.condition_of(tag)
          if name.nil?
            boolean = tag.match(/\A@with:([A-Za-z0-9_.-]+)=(true|false)\z/)
            message = if boolean
                        "#{tag} names a boolean as text, which reads two ways: write #{boolean[2] == "true" ? "@with:" : "@without:"}#{boolean[1]}, which reads the boolean the program file declares"
                      else
                        "#{tag} does not read as @with:<condition>, @with:<condition>=<value>, or @without:<condition>, so it names no condition"
                      end
            findings << Finding.new("error", "condition-tag-malformed", uri, line, nil, message, Codes.fix("condition-tag-malformed"))
          elsif conditions && !conditions.include?(name)
            on, off = tag.start_with?("@without:") ? %w[off on] : %w[on off]
            findings << Finding.new("error", "condition-unknown", uri, line, nil,
                                    %(#{tag} names the condition "#{name}", and no environment in nukadoko.program.rb declares it under conditions. ) +
                                      "If #{name} was removed and its #{on} side kept, remove the tag, so the scenario holds everywhere; if its #{off} side was kept, delete the scenario.",
                                    Codes.fix("condition-unknown"))
          end
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
        @scenarios.group_by { [_1.uri, _1.keyword_line] }.each_value do |rows|
          scenario = rows.first
          if rows.size > 1 && scenario.columns.none? { scenario.outline_name.include?("<#{_1}>") }
            findings << Finding.new("warning", "outline-rows-share-name", scenario.uri, scenario.keyword_line, nil,
                                    %(Scenario outline "#{scenario.name}" has #{rows.size} Examples rows, and its name uses none of the columns (#{scenario.columns.map { "<#{_1}>" }.join(", ")}), so every row is reported under the same name.),
                                    "Add a column to the name, such as: #{scenario.name} <#{scenario.columns.first}>")
          end
          own = scenario.steps.reject(&:background)
          next if own.empty? || scenario.steps.any? { _1.kind.to_s == "Outcome" }

          message = if own.all? { _1.kind.to_s == "Unknown" }
                      %(Scenario "#{scenario.name}" has only * lines, so no line is in Then position and no claim is judged: it passes whenever its steps run without an error.)
                    else
                      %(Scenario "#{scenario.name}" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.)
                    end
          findings << Finding.new("warning", "scenario-without-then", scenario.uri, scenario.keyword_line, nil, message, Codes.fix("scenario-without-then"))
        end
      end

      def check_lines
        undefined = []
        @scenarios.each do |scenario|
          scenario.steps.each do |line|
            matches = Engine.matches(@usable, line.text)
            case matches.size
            when 0 then undefined << [scenario, line]
            when 1
              check_fill(scenario, line, *matches.first)
              check_position(scenario, line, matches.first.first)
            else
              findings << Finding.new("error", "ambiguous-step", scenario.uri, line.line, nil,
                                      %("#{line.text}" matches more than one step: #{matches.map { _1.first.step_name }.join(", ")}), Codes.fix("ambiguous-step"))
            end
          end
        end
        suppress_undefined(undefined)
        @scenarios.each { judging_nothing(_1) }
      end

      # A scenario whose Then lines each bind one step, none of them a claim
      # step, passes whenever its steps run.
      def judging_nothing(scenario)
        thens = scenario.steps.select { _1.kind.to_s == "Outcome" }
        return if thens.empty?

        steps = thens.map { Engine.matches(@usable, _1.text) }
        return unless steps.all? { _1.size == 1 }
        return if steps.any? { _1.first.first.claims }

        findings << Finding.new("warning", "scenario-without-then", scenario.uri, thens.first.line, nil,
                                %(Scenario "#{scenario.name}" judges no claim: none of its Then lines binds a claim step, so it passes whenever its steps run without an error.),
                                Codes.fix("scenario-without-then"))
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

      KEYWORD = { "Context" => "Given", "Action" => "When", "Outcome" => "Then" }.freeze

      # Only a Then judges, so a claim step elsewhere and a step that runs in
      # Then position are both mistakes.
      def check_position(scenario, line, step)
        then_line = line.kind.to_s == "Outcome"
        if then_line && !step.claims
          findings << Finding.new("error", "then-without-claims", scenario.uri, line.line, step.step_name,
                                  %(Step "#{step.step_name}" is bound in Then position and runs instead of declaring claims. A Then judges through claims (docs/spec.md "Claims"); a step that only reads or records a value belongs in a Given or When),
                                  Codes.fix("then-without-claims"))
        elsif !then_line && step.claims
          findings << Finding.new("error", "claims-outside-then", scenario.uri, line.line, step.step_name,
                                  %(Step "#{step.step_name}" declares claims and is bound in #{KEYWORD.fetch(line.kind.to_s, "*")} position. Only a Then judges, so a broken claim here would read as a setup that broke (docs/spec.md "Claims")),
                                  Codes.fix("claims-outside-then"))
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
