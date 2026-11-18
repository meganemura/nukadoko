# frozen_string_literal: true
# rbs_inline: enabled

# What `check` can say without running anything: every finding follows from
# the step classes, their patterns and schemas, `Method#parameters`, and the
# feature files. The codes are the TypeScript engine's codes, so one set of
# conformance cases judges both engines.
module Nukadoko
  module Engine
    Finding = Data.define(
      :severity, #: String
      :code, #: String
      :file, #: String?
      :line, #: Integer?
      :step, #: String?
      :message, #: String
      :fix, #: String?
      # The command that is the next step, printed as `do:`; most findings have none.
      :run, #: String?
    )

    # A Data block's methods are its own, but rbs-inline reads only a class
    # body, so they are written in one.
    class Finding
      #: (String, String, singleton(Step), String, String?) -> Finding
      def self.about_step(severity, code, step, message, fix)
        new(severity, code, step.file, step.line, step.step_name, message, fix, nil)
      end

      #: () -> Hash[Symbol, untyped]
      def to_h
        hash = super.compact
        hash[:do] = hash.delete(:run) if hash.key?(:run)
        hash
      end
    end

    FIXTURES = %w[baseURL base_url call context env evidence page pageAs page_as poll request requireEnv require_env resultOf result_of scratch section].freeze

    class Check
      attr_reader :findings #: Array[Finding]
      attr_reader :usable #: Array[singleton(Step)]

      # `environments` is the selection a run without --env starts, for
      # condition-unmet; nil when --env named the selection. `problems` are
      # what the feature loader found that runs nothing.
      # `config` holds what was found in the config and its program before
      # any step loaded, such as an env file that is missing.
      #: (Array[singleton(Step)], Array[Scenario], ?features: bool, ?full: bool, ?conditions: Array[String]?, ?environments: Array[Environment]?, ?problems: Array[FeatureProblem], ?config: Array[Finding]) -> void
      def initialize(steps, scenarios, features: true, full: false, conditions: nil, environments: nil, problems: [], config: [])
        @steps = steps
        @scenarios = scenarios
        @conditions = conditions
        @findings = []
        # With no step file no line can ever match, so every line would read
        # as undefined; one finding says why instead.
        if !features
          @findings << Finding.new("error", "features-dir-missing", "nukadoko.config.rb", nil, nil, %(featuresDir "features" does not exist),
                                   "Create features/steps for the step files, or correct featuresDir in nukadoko.config.rb.", nil)
        elsif steps.empty?
          @findings << Finding.new("error", "no-step-files-found", "features", nil, nil,
                                   %(no .rb step file was found while scanning "features"; no step can ever be registered), Codes.fix("no-step-files-found"), nil)
        end
        @findings.concat(config)
        # The config's parameterTypes did not register, so no pattern binds a
        # line; that is said once, not once per pattern.
        if (collision = Pattern.collision)
          @findings << Finding.new("error", "parameter-type-invalid", nil, nil, nil, collision, Codes.fix("parameter-type-invalid"), nil)
        end
        @usable = steps.reject { definition_broken?(_1) }
        @usable.each { check_contract(_1) }
        check_duplicate_patterns
        check_parts
        check_shapes
        check_tags(conditions)
        check_lines
        # One finding per cause: each undefined line already names the
        # scaffold command for its file, so the missing step files would be
        # said a second time.
        @findings.reject! { _1.code == "no-step-files-found" } if steps.empty? && @findings.any? { _1.code == "undefined-step" }
        check_fixtures(full)
        check_conditions_met(environments) if environments
        problems.each { |problem| findings << Finding.new("error", problem.code, problem.uri, problem.line, nil, problem.message, Codes.fix(problem.code), nil) }
        if full
          check_unbound
          check_from_unused
          check_unused_parameter_types
        end
        # Errors, then warnings, then notes, each kind in the order found, as
        # the TypeScript engine reports them.
        rank = { "error" => 0, "warning" => 1, "note" => 2 }
        @findings = @findings.uniq { [_1.code, _1.file, _1.line, _1.message] }.each_with_index.sort_by { |f, i| [rank.fetch(f.severity, 3), i] }.map(&:first)
      end

      #: () -> bool
      def passed? = findings.none? { _1.severity == "error" }

      private

      # A step whose definition cannot stand (an unknown claim compare) is left
      # out of the vocabulary, as the TypeScript engine leaves out a step file
      # that fails to import, so it can never match a line.
      #: (singleton(Step)) -> bool
      def definition_broken?(step)
        broken = step.patterns.filter_map { pattern_problem(step, _1) }
        broken.each { findings << Finding.new("error", _1[0], step.file, nil, step.step_name, _1[1], Codes.fix(_1[0]), nil) }
        return true if broken.any?
        problems = Definition.new(step).problems
        problems.each do |problem|
          findings << Finding.about_step("error", "step-file-import-failed", step, problem,
                                         "Correct the import or the error that the message names in the file, then run nuka check again.")
        end
        problems.any?
      end

      KEY = /\A[A-Za-z_][A-Za-z0-9_]*\z/

      # Why the step's pattern cannot be read, as the TypeScript engine says
      # it: the first broken capture, then what cucumber-expressions refuses.
      #: (singleton(Step), String) -> [String, String]?
      def pattern_problem(step, pattern)
        head = %(Step "#{step.step_name}" pattern "#{pattern}")
        keys = []
        rest = pattern.gsub(/\./, "")
        open = rest.index("{")
        while open
          close = rest.index("}", open)
          return ["unterminated-capture", %(#{head}: Pattern has an unterminated "{" starting at: #{rest[open..]})] unless close

          token = rest[open + 1...close].to_s
          key, type = token.split(":", 2)
          return ["unnamed-capture", %(#{head}: Parameter "{#{token}}" has no name; every parameter in a pattern must be written {key:type} (docs/spec.md "Typed steps"))] unless type
          return ["invalid-capture-key", %(#{head}: Parameter "{#{token}}" has an invalid name "#{key}": must match [a-zA-Z_][a-zA-Z0-9_]*)] unless key.to_s.match?(KEY)

          keys << key
          open = rest.index("{", close)
        end
        repeated = keys.tally.select { _2 > 1 }.keys.first
        return ["duplicate-capture-key", %(#{head} binds key "#{repeated}" more than once)] if repeated

        Pattern.new(pattern)
        nil
      rescue Cucumber::CucumberExpressions::UndefinedParameterTypeError => e
        types = Pattern.registry.parameter_types.map(&:name).reject(&:empty?).sort
        ["unknown-parameter-type", "#{head}: #{e.message} This project's registered parameter types are: #{types.join(", ")}."]
      rescue StandardError => e
        ["pattern-syntax-error", "#{head}: #{e.message}"]
      end

      NUMBER_TYPES = %w[int float bigdecimal biginteger byte short long double].freeze
      STRING_TYPES = %w[string word].freeze

      # A capture hands the step a number or a string, and an args field of
      # the other kind can never hold it.
      #: (singleton(Step), String) -> Array[Array[untyped]]
      def capture_mismatches(step, pattern)
        fields = step.args.fields.to_h { [_1.name.to_s, _1.type] }
        pattern.scan(Pattern::NAMED).filter_map do |key, type|
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

      #: (singleton(Step)) -> void
      def check_contract(step)
        keys = step.args.fields.map { _1.name.to_s }
        step.patterns.each do |pattern|
          (Pattern.new(pattern).keys - keys).each do |key|
            findings << Finding.about_step("error", "unknown-capture-key", step,
                                           %(Step "#{step.step_name}" pattern "#{pattern}" binds key "#{key}", which is not a key of its args schema),
                                           "Rename the capture to a key of the args schema, or add the key to the schema.")
          end
        end
        check_alias_keys(step)
        undescribed = [step.args, step.returns].compact.flat_map(&:fields).reject(&:description)
        if undescribed.any?
          findings << Finding.about_step("note", "schema-field-undescribed", step,
                                         "Step \"#{step.step_name}\" has schema fields with no description: #{undescribed.map(&:name).join(", ")}",
                                         "Give each field a description, so nuka steps and an agent can say what it means.")
        end
        step.patterns.flat_map { |pattern| capture_mismatches(step, pattern).map { [pattern, *_1] } }.each do |pattern, key, type, captured, held|
          findings << Finding.new("error", "capture-type-mismatch", step.file, nil, step.step_name,
                                  %(Step "#{step.step_name}" pattern "#{pattern}" binds key "#{key}" as {#{type}} (a #{captured}), but args declares "#{key}" as a #{held}),
                                  "Make the capture type and the args field type agree: change the {key:type} in the pattern, or declare the field with the type the capture gives.", nil)
        end
        known = FIXTURES + Nukadoko.project_fixtures.keys.map(&:to_s)
        (step.fixtures.map(&:to_s) - known).each do |name|
          findings << Finding.about_step("error", "fixture-structural-violation", step,
                                         %(#{step.body}() names unknown fixture "#{name}": known fixtures are #{known.uniq.sort.join(", ")}),
                                         "Name a known fixture as a keyword argument.")
        end
      end

      # Every wording of one step must hand it the same args, or which line
      # was written would decide what the step receives.
      #: (singleton(Step)) -> void
      def check_alias_keys(step)
        return if step.patterns.size < 2

        keys = step.patterns.map { [_1, Pattern.new(_1).keys.uniq] }
        return if keys.map { _2.sort }.uniq.size == 1

        findings << Finding.about_step("error", "alias-key-mismatch", step,
                                       "Step \"#{step.step_name}\" has patterns that bind different key sets: #{keys.map { %("#{_1}" -> {#{_2.join(", ")}}) }.join("; ")}",
                                       Codes.fix("alias-key-mismatch"))
      end

      # Two patterns that read the same once their names go would match the
      # same lines; the later file is named, with every step that shares it.
      #: () -> void
      def check_duplicate_patterns
        owned = @usable.sort_by(&:file).flat_map { |step| step.patterns.map { |pattern| [step, pattern] } } #: Array[[singleton(Step), String]]
        owned.group_by { |_, pattern| pattern.gsub(Pattern::NAMED) { "{#{Regexp.last_match(2)}}" } }.each do |text, group|
          next if group.size < 2

          last = group.last or next
          findings << Finding.new("error", "duplicate-pattern", last[0].file, nil, nil,
                                  %(Multiple patterns normalize to the same text "#{text}": #{group.map { |step, pattern| %(#{step.step_name} ("#{pattern}")) }.join(", ")}),
                                  Codes.fix("duplicate-pattern"), nil)
        end
      end

      # A pattern no line binds alone has no place in a scenario; a placeholder
      # description is what a person picking a step would read.
      #: () -> void
      def check_unbound
        unbound_steps.each do |step|
          findings << Finding.new("note", "pattern-unbound", step.file, nil, step.step_name,
                                  %(Step "#{step.step_name}" declares a pattern, but no feature line under the scanned directories (features) binds it. It has no place in any scenario right now.),
                                  Codes.fix("pattern-unbound"), nil)
        end
        @usable.select { _1.description.to_s == "TODO: describe #{_1.step_name}" }.sort_by(&:file).each do |step|
          findings << Finding.new("note", "step-description-todo", step.file, nil, step.step_name,
                                  %(Step "#{step.step_name}" still has the description nuka scaffold wrote ("#{step.description}"); nuka steps and nuka describe show it to whoever picks a step, so say what the step does.),
                                  Codes.fix("step-description-todo"), nil)
        end
      end

      # A config parameter type no pattern names.
      #: () -> void
      def check_unused_parameter_types
        used = @steps.flat_map { _1.patterns.flat_map { |pattern| pattern.scan(/\{(?:[^}:]*:)?([^}]*)\}/).flatten } }
        (Nukadoko.config_options[:parameterTypes] || []).each do |type|
          name = type[:name].to_s
          next if used.include?(name)

          findings << Finding.new("note", "parameter-type-unused", CONFIG, nil, nil,
                                  %(Configured parameter type "#{name}" is not referenced by any typed or compat pattern.), Codes.fix("parameter-type-unused"), nil)
        end
      end

      # A claim whose expected value is an args key a type with a
      # transformer fills compares with what code made of the line, while
      # the record would name the sentence as its source.
      #: (singleton(Step)) -> void
      def check_transformed(step)
        transformed = Pattern.transformed
        claims = step.claims
        return if transformed.empty? || claims.nil? || step.patterns.empty?

        keys = {} #: Hash[String, String]
        claims.each_with_index do |claim, index|
          label = "claims[#{index}]"
          each = claim[:each]
          unless each
            keys[claim[:expected].to_s] ||= label if claim[:expected].is_a?(String)
            next
          end
          items = (Array(each[:where]).each_with_index.map { |item, i| ["#{label}.each.where[#{i}]", item] } +
                  Array(each[:claims]).each_with_index.map { |item, i| ["#{label}.each.claims[#{i}]", item] }) #: Array[[String, Hash[Symbol, untyped]]]
          items.each { |item_label, item| keys[item[:expected].to_s] ||= item_label if item[:expected].is_a?(String) }
        end
        step.patterns.flat_map { |pattern| pattern.scan(Pattern::NAMED).map { [pattern, *Array(_1).map(&:to_s)] } }.each do |pattern, key, type|
          label = keys[key.to_s]
          next unless label && transformed.include?(type.to_s)

          findings << Finding.about_step("error", "claim-expected-transformed", step,
                                         %(Step "#{step.step_name}"'s #{label}.expected is args.#{key}, and its pattern "#{pattern}" fills it with the parameter type {#{type}}, ) +
                                         "whose transformer rewrites the line's text before the claim reads it, so code would decide what the claim compares. " \
                                         "Capture #{key} with a type that has no transformer, such as {#{key}:string}, and read it with expected_view if it needs one",
                                         Codes.fix("claim-expected-transformed"))
        end
      end

      # A from key every line fills with a capture never takes its value
      # from the producer it names.
      #: () -> void
      def check_from_unused
        bound = @scenarios.flat_map(&:steps).filter_map { |line| (m = Engine.matches(@usable, line.text)).size == 1 ? m.first : nil }
        @usable.each do |step|
          occurrences = bound.select { _1.first == step }.map(&:last)
          next if occurrences.empty?

          step.from.each_key do |key|
            next unless occurrences.all? { _1.key?(key) }

            findings << Finding.new("note", "from-unused", step.file, nil, step.step_name,
                                    %(Step "#{step.step_name}"'s from.#{key} declares a producer, but every bound occurrence of this step already fills "#{key}" from a pattern capture. That producer has never supplied it. Still reachable through `nuka do --use`; this is a fact, not a verdict on whether to remove it.),
                                    Codes.fix("from-unused"), nil)
          end
        end
      end

      # A from key whose producer has not run before the line fails args
      # validation with certainty, and two producers that both ran leave
      # the feature file unable to say which one counts. A line before it
      # that matches no step may be the producer misspelled, so those
      # findings wait behind one warning.
      #: (Scenario) -> void
      def check_from_order(scenario)
        resolved = scenario.steps.map { |line| (m = Engine.matches(@usable, line.text)).size == 1 ? m.first : nil }
        held = []
        resolved.each_with_index do |(step, captures), index|
          next unless step

          step.from.each do |key, sources|
            next if captures.key?(key) || step.args.fields.none? { _1.name.to_s == key }

            names = sources.filter_map { |producer, _| producer.step_name if @usable.include?(producer) }.uniq
            next if names.empty?

            before = names.select { |name| resolved.first(index).any? { _1&.first&.step_name == name } }
            next if before.size == 1

            line = scenario.steps[index]
            if before.size > 1
              quoted = before.map { %("#{_1}") }.join(", ")
              findings << Finding.new("error", "from-order-violation", scenario.uri, line.line, step.step_name,
                                      %(Step "#{step.step_name}"'s from.#{key} has more than one of its candidate producers bound earlier in this scenario (#{quoted}): from's candidates are mutually exclusive by design (docs/spec.md "Chaining steps"), so the feature file, not the tool, must make exactly one of them win),
                                      "Remove or move lines so that exactly one of steps #{quoted} runs before this line.", nil)
              next
            end
            # An optional key may stay empty: the schema says absent is fine.
            next unless step.args.required_names.include?(key)

            undefined = scenario.steps.first(index).each_index.select { Engine.matches(@usable, scenario.steps[_1].text).empty? }
            issue = { index: index, step: step.step_name, key: key, candidates: names }
            next held << issue.merge(undefined: undefined) if undefined.any?

            findings << Finding.new("error", "from-order-violation", scenario.uri, line.line, step.step_name,
                                    from_missing_message(step.step_name, key, names, resolved),
                                    from_order_fix(issue), nil)
          end
        end
        hold_from_order(scenario, held) if held.any?
      end

      # What a claim step's claims read, from the producers of its from
      # values on the earlier lines of the scenario (ClaimCheck).
      #: (Scenario) -> void
      def check_claim_sources(scenario)
        resolved = scenario.steps.map { |line| (m = Engine.matches(@usable, line.text)).size == 1 ? m.first : nil }
        lines = scenario.steps.map(&:line)
        resolved.each_index do |index|
          ClaimCheck.issues(resolved, lines, index).each do |code, message|
            findings << Finding.new("error", code, scenario.uri, lines[index], resolved[index]&.first&.step_name, message, Codes.fix(code), nil)
          end
        end
      end

      #: (String, String, Array[String], Array[untyped]) -> String
      def from_missing_message(step_name, key, names, resolved)
        anywhere = ->(name) { resolved.any? { _1&.first&.step_name == name } }
        if names.size == 1
          name = names.first
          detail = anywhere.(name) ? %("#{name}" is bound in this scenario, but only at or after this line, never before it) : %("#{name}" is never bound anywhere in this scenario)
          return %(Step "#{step_name}"'s from.#{key} needs step "#{name}" to have already run earlier in this scenario, but #{detail}. This line would fail args validation with certainty)
        end
        detail = names.map { anywhere.(_1) ? %("#{_1}" is bound only at or after this line, never before it) : %("#{_1}" is never bound anywhere in this scenario) }.join("; ")
        %(Step "#{step_name}"'s from.#{key} needs exactly one of its candidate producers (#{names.map { %("#{_1}") }.join(", ")}) to have already run earlier in this scenario, but none has: #{detail}. This line would fail args validation with certainty)
      end

      #: (Hash[Symbol, untyped]) -> String
      def from_order_fix(issue)
        names = issue[:candidates]
        put = names.size == 1 ? %(Put a line that runs step "#{names.first}" earlier in the scenario) : "Put a line that runs exactly one of steps #{names.map { %("#{_1}") }.join(", ")} earlier in the scenario"
        return "#{put}." if issue[:index].zero?

        %(#{put}. Or, if a step that an earlier line runs returns #{issue[:key]}, list that step as another [step, "#{issue[:key]}"] candidate in from.#{issue[:key]} of step "#{issue[:step]}".)
      end

      #: (Scenario, Array[Hash[Symbol, untyped]]) -> void
      def hold_from_order(scenario, held)
        steps_phrase = ->(names) { names.size == 1 ? %(step "#{names.first}") : "one of steps #{names.map { %("#{_1}") }.join(", ")}" }
        undefined = held.flat_map { _1[:undefined] }.uniq.sort
        consumers = held.group_by { [_1[:index], _1[:candidates]] }.map do |(index, candidates), issues|
          "line #{scenario.steps[index].line} step \"#{issues.first[:step]}\" needs #{steps_phrase.(candidates)} for #{issues.map { _1[:key] }.join(", ")}"
        end
        lines = undefined.map { %(line #{scenario.steps[_1].line} "#{scenario.steps[_1].text}") }
        which = lines.size == 1 ? lines.first : "one of #{lines.join(", ")}"
        count = held.size == 1 ? "1 from-order-violation finding" : "#{held.size} from-order-violation findings"
        findings << Finding.new("warning", "from-order-check-suppressed", scenario.uri, scenario.steps[undefined.first].line, nil,
                                "Held back #{count} while #{lines.join(", ")} #{lines.size == 1 ? "matches" : "match"} no step, because such a line may be meant to run the producer they need: #{consumers.join("; ")}",
                                "If #{which} is meant to run #{steps_phrase.(held.flat_map { _1[:candidates] }.uniq)}, reword that line to match that step's pattern. Otherwise fix the undefined-step finding first, then run nuka check again: a held-back finding that still applies is reported then.", nil)
      end

      SCENARIO_ONLY = FIXTURES - %w[env requireEnv require_env baseURL base_url]

      # Fixture definitions that can never resolve, and (in a whole-project
      # check) one no step reaches.
      #: (bool) -> void
      def check_fixtures(full)
        fixtures = Nukadoko.project_fixtures
        return if fixtures.empty?

        config = CONFIG
        state = Hash.new(:white)
        visit = lambda do |name, stack|
          state[name] = :gray
          stack.push(name)
          fixtures[name].dependencies.each do |dep|
            next unless fixtures.key?(dep) && dep != name

            if state[dep] == :gray
              cycle = [*stack.drop(stack.index(dep)), dep]
              findings << Finding.new("error", "fixture-cycle", config, nil, nil, "fixture dependency cycle: #{cycle.join(" -> ")}", Codes.fix("fixture-cycle"), nil)
            elsif state[dep] == :white
              visit.(dep, stack)
            end
          end
          stack.pop
          state[name] = :black
        end
        fixtures.each_key { visit.(_1, []) if state[_1] == :white }

        # An override of page that names no browser fixture cannot hand back
        # a page the engine launched, records, and traces.
        if (page = fixtures[:page]) && (page.dependencies & %i[page context pageAs page_as]).empty?
          findings << Finding.new("error", "page-override-unowned", config, nil, nil,
                                  %(fixture "page" overrides the builtin page but destructures none of "page", "context", or "pageAs": there is no way for it to hand back a page the executor still owns and measures),
                                  Codes.fix("page-override-unowned"), nil)
        end

        fixtures.each_value do |fixture|
          next unless fixture.scope == :process

          fixture.dependencies.each do |dep|
            scenario = fixtures.key?(dep) && dep != fixture.name ? fixtures[dep].scope == :scenario : SCENARIO_ONLY.include?(dep.to_s)
            next unless scenario

            findings << Finding.new("error", "fixture-scope-violation", config, nil, nil,
                                    %(fixture "#{fixture.name}" has scope "process" but depends on "#{dep}", which is scope "scenario": a "process"-scope fixture is built once for the whole run and can outlive any single scenario's own resources, so it cannot depend on something rebuilt per scenario),
                                    Codes.fix("fixture-scope-violation"), nil)
          end
        end
        return unless full

        reachable = []
        pending = @steps.flat_map(&:bag)
        until pending.empty?
          name = pending.shift
          next if reachable.include?(name)

          reachable << name
          pending.concat(fixtures[name].dependencies) if fixtures.key?(name)
        end
        (fixtures.keys - reachable).each do |name|
          findings << Finding.new("note", "fixture-unused", config, nil, nil,
                                  %(Fixture "#{name}" is declared under nukadoko.config.rb's own `fixtures`, but no typed step requires it, directly or through another fixture. Still reachable through `nuka do`; this is a fact, not a verdict on whether to remove it.),
                                  Codes.fix("fixture-unused"), nil)
        end
      end

      # A scenario whose condition tags no environment of the selection meets
      # has no required cell, so nothing in the run shows that it holds.
      #: (Array[Environment]) -> void
      def check_conditions_met(environments)
        declared = @conditions || []
        described = environments.map { |e| "#{e.name} (#{describe_conditions(e.conditions)})" }.join("; ")
        @scenarios.uniq { [_1.uri, _1.line] }.each do |scenario|
          tags = Table.condition_tags(scenario.tags)
          next if tags.empty?

          names = tags.map { Check.condition_of(_1) }
          next if names.any?(&:nil?) || names.any? { !declared.include?(_1) }
          next if environments.any? { Table.role(tags, _1.conditions) == "required" }

          findings << Finding.new("error", "condition-unmet", scenario.uri, scenario.line, nil,
                                  %(Scenario "#{scenario.name}" needs #{tags.join(" ")}, and no selected environment meets #{tags.size == 1 ? "it" : "all of them"}: #{described}. Its cells would all be controls, so nothing would show that it holds),
                                  Codes.fix("condition-unmet"), nil)
        end
      end

      #: (Hash[String, untyped]) -> String
      def describe_conditions(conditions)
        return "no conditions" if conditions.empty?

        conditions.map { |name, value| "#{name}: #{value.is_a?(String) ? JSON.generate(value) : value}" }.join(", ")
      end

      CONDITION_NAME = /\A[A-Za-z0-9_.-]+\z/
      CONDITION_VALUE = /\A[^\s@]+\z/

      # The condition a tag names, nil for one that does not read.
      #: (String) -> String?
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
      #: (String) -> String?
      def self.expects_problem(tag)
        kind, value = tag.delete_prefix("@expects:").split("=", 2)
        rule = EXPECTED[kind]
        return "#{tag} does not read as #{EXPECTS_FORMS}, so it accepts nothing" unless rule
        return "#{tag} names no value, and an @expects tag names what it accepts: #{rule[2]}" if value.nil? || value.empty?
        return nil if value.match?(rule[0])

        "#{tag} does not name #{rule[2]}, so it accepts nothing#{": a run judges no other status, and one tag names one status" if kind == "status"}"
      end

      #: (Array[String]?) -> void
      def check_tags(conditions)
        @scenarios.flat_map { |scenario| scenario.tag_lines.map { |tag, line| [scenario.uri, line, tag] } }.uniq.each do |uri, line, tag|
          if tag.start_with?("@expects:")
            problem = Check.expects_problem(tag)
            findings << Finding.new("error", "expects-tag-malformed", uri, line, nil, problem, Codes.fix("expects-tag-malformed"), nil) if problem
            next
          end
          next unless tag.start_with?("@with:", "@without:")

          name = Check.condition_of(tag)
          if name.nil?
            boolean = tag.match(/\A@with:([A-Za-z0-9_.-]+)=(true|false)\z/)
            message = if boolean
                        "#{tag} names a boolean as text, which reads two ways: write #{boolean[2] == "true" ? "@with:" : "@without:"}#{boolean[1]}, which reads the boolean the program declares"
                      else
                        "#{tag} does not read as @with:<condition>, @with:<condition>=<value>, or @without:<condition>, so it names no condition"
                      end
            findings << Finding.new("error", "condition-tag-malformed", uri, line, nil, message, Codes.fix("condition-tag-malformed"), nil)
          elsif conditions && !conditions.include?(name)
            on, off = tag.start_with?("@without:") ? %w[off on] : %w[on off]
            findings << Finding.new("error", "condition-unknown", uri, line, nil,
                                    %(#{tag} names the condition "#{name}", and no environment in nukadoko.config.rb declares it under conditions. ) +
                                      "If #{name} was removed and its #{on} side kept, remove the tag, so the scenario holds everywhere; if its #{off} side was kept, delete the scenario.",
                                    Codes.fix("condition-unknown"), nil)
          end
        end
      end

      # A cycle never closes into a fixture bag, and a read-only step cannot
      # reach a part that writes: both can only end one way, so both are errors.
      #: () -> void
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
      #: () -> Array[Array[singleton(Step)]]
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
      #: () -> void
      def check_shapes
        @scenarios.group_by { [_1.uri, _1.keyword_line] }.each_value do |rows|
          scenario = rows.first
          if rows.size > 1 && scenario.columns.none? { scenario.outline_name.include?("<#{_1}>") }
            findings << Finding.new("warning", "outline-rows-share-name", scenario.uri, scenario.keyword_line, nil,
                                    %(Scenario outline "#{scenario.name}" has #{rows.size} Examples rows, and its name uses none of the columns (#{scenario.columns.map { "<#{_1}>" }.join(", ")}), so every row is reported under the same name.),
                                    "Add a column to the name, such as: #{scenario.name} <#{scenario.columns.first}>", nil)
          end
          own = scenario.steps.reject(&:background)
          next if own.empty? || scenario.steps.any? { _1.kind.to_s == "Outcome" }

          message = if own.all? { _1.kind.to_s == "Unknown" }
                      %(Scenario "#{scenario.name}" has only * lines, so no line is in Then position and no claim is judged: it passes whenever its steps run without an error.)
                    else
                      %(Scenario "#{scenario.name}" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.)
                    end
          findings << Finding.new("warning", "scenario-without-then", scenario.uri, scenario.keyword_line, nil, message, Codes.fix("scenario-without-then"), nil)
        end
      end

      #: () -> void
      def check_lines
        undefined = []
        bound = [] #: Array[singleton(Step)]
        @scenarios.each do |scenario|
          scenario.steps.each do |line|
            matches = Engine.matches(@usable, line.text)
            case matches.size
            when 0 then undefined << [scenario, line]
            when 1
              step, captures = matches.first
              bound << step
              check_fill(scenario, line, step, captures)
              check_position(scenario, line, step)
              check_kinds(scenario, line, step, captures)
              check_unfit_trees(scenario, line, step, captures)
              check_poll(step)
            else
              findings << Finding.new("error", "ambiguous-step", scenario.uri, line.line, nil,
                                      %("#{line.text}" matches more than one step: #{matches.map { _1.first.step_name }.join(", ")}), Codes.fix("ambiguous-step"), nil)
            end
          end
        end
        bound.uniq.each { check_transformed(_1) }
        @scenarios.each { check_from_order(_1) }
        @scenarios.each { check_claim_sources(_1) }
        suppress_undefined(undefined)
        @scenarios.each { judging_nothing(_1) }
      end

      # A scenario whose Then lines each bind one step, none of them a claim
      # step, passes whenever its steps run.
      #: (Scenario) -> void
      def judging_nothing(scenario)
        thens = scenario.steps.select { _1.kind.to_s == "Outcome" }
        return if thens.empty?

        steps = thens.map { Engine.matches(@usable, _1.text) }
        return unless steps.all? { _1.size == 1 }
        return if steps.any? { _1.first.first.claims }

        findings << Finding.new("warning", "scenario-without-then", scenario.uri, thens.first.line, nil,
                                %(Scenario "#{scenario.name}" judges no claim: none of its Then lines binds a claim step, so it passes whenever its steps run without an error.),
                                Codes.fix("scenario-without-then"), nil)
      end

      # The steps with a pattern that no line binds alone. A step whose file
      # failed to load is out of the vocabulary, so it is not unbound either.
      #: () -> Array[singleton(Step)]
      def unbound_steps
        @unbound_steps ||= begin
          bound = @scenarios.flat_map(&:steps).filter_map { |line| (m = Engine.matches(@usable, line.text)).size == 1 ? m.first.first : nil }
          unread = findings.select { _1.code == "step-file-import-failed" }.map(&:step)
          @steps.reject { _1.patterns.empty? }.reject { bound.include?(_1) || unread.include?(_1.step_name) }.sort_by(&:file)
        end
      end

      # A renamed sentence or pattern leaves one line undefined and one step
      # unbound at once, so an undefined line names the unbound steps, at
      # most three, beside the scaffold command that would write a duplicate.
      #: () -> String
      def unbound_suffix
        steps = unbound_steps
        return "" if steps.empty?

        named = steps.first(3).map { %(#{_1.step_name} (#{_1.patterns.map { |text| %("#{text}") }.join(", ")}, #{_1.file})) }
        rest = steps.size - named.size
        "; patterned steps no scanned feature line binds: #{rest.positive? ? "#{named.join(", ")}, and #{rest} more" : named.join(", ")}"
      end

      # While a step definition is broken, a line it would have matched looks
      # undefined. Saying so would send the reader after the wrong fix, so the
      # judgment waits for the broken definition, with one warning.
      #: (Array[untyped]) -> void
      def suppress_undefined(undefined)
        broken = @steps - @usable
        if broken.any? && undefined.any?
          findings << Finding.about_step("warning", "undefined-step-check-suppressed", broken.first,
                                         "Suppressed #{undefined.size} undefined-step #{undefined.size == 1 ? "issue" : "issues"} because #{broken.size} step #{broken.size == 1 ? "file" : "files"} could not be read. undefined-step judgment is on hold until the unreadable glue is fixed",
                                         "Correct the step-file-import-failed error, then run nuka check again.")
          return
        end
        undefined.each do |scenario, line|
          findings << Finding.new("error", "undefined-step", scenario.uri, line.line, nil,
                                  %(No step definition matches "#{line.text}"#{unbound_suffix}), nil, "nuka scaffold --feature #{Selection.shell_word(scenario.uri)}")
        end
      end

      KEYWORD = { "Context" => "Given", "Action" => "When", "Outcome" => "Then" }.freeze

      # Only a Then judges, so a claim step elsewhere and a step that runs in
      # Then position are both mistakes.
      #: (Scenario, PickleStep, singleton(Step)) -> void
      def check_position(scenario, line, step)
        then_line = line.kind.to_s == "Outcome"
        if then_line && !step.claims
          findings << Finding.new("error", "then-without-claims", scenario.uri, line.line, step.step_name,
                                  %(Step "#{step.step_name}" is bound in Then position and runs instead of declaring claims. A Then judges through claims (docs/spec.md "Claims"); a step that only reads or records a value belongs in a Given or When),
                                  Codes.fix("then-without-claims"), nil)
        elsif !then_line && step.claims
          findings << Finding.new("error", "claims-outside-then", scenario.uri, line.line, step.step_name,
                                  %(Step "#{step.step_name}" declares claims and is bound in #{KEYWORD.fetch(line.kind.to_s, "*")} position. Only a Then judges, so a broken claim here would read as a setup that broke (docs/spec.md "Claims")),
                                  Codes.fix("claims-outside-then"), nil)
        end
      end

      # A page between two renders can show any state for one frame, so a
      # claim step whose observe reaches a page, directly or through a
      # project fixture, has to say whether it reads once or until its
      # claims hold. Reported once for each step.
      #: (singleton(Step)) -> void
      def check_poll(step)
        return unless step.claims && step.method_defined?(:observe) && step.poll.nil?
        return if (@poll_reported ||= {}).key?(step)

        @poll_reported[step] = true
        return unless reaches_browser?(step.bag)

        findings << Finding.about_step("error", "claim-poll-unstated", step,
                                       %(Step "#{step.step_name}" observes a browser page and does not state poll. ) +
                                         "Write poll: { timeout_ms } to read until every claim holds on two consecutive readings, or poll: false to read once",
                                       Codes.fix("claim-poll-unstated"))
      end

      #: (Array[Symbol]) -> bool
      def reaches_browser?(names)
        fixtures = Nukadoko.project_fixtures
        seen = [] #: Array[Symbol]
        pending = names.dup
        while (name = pending.shift)
          next if seen.include?(name)

          seen << name
          return true if Vocabulary::BROWSER.include?(name)

          pending.concat(fixtures[name].dependencies) if fixtures.key?(name)
        end
        false
      end

      # The key a table or docstring fills is what the line states; a claim
      # step that neither compares a claim with it nor observes checks
      # nothing the line said.
      #: (untyped, untyped, singleton(Step), String) -> void
      def check_unread(scenario, line, step, key)
        claims = step.claims
        return unless claims && !step.method_defined?(:observe) && !claim_keys_read(claims).include?(key)

        attached = line.doc_string ? "docstring" : "table"
        findings << Finding.new("error", "claim-sentence-unread", scenario.uri, line.line, step.step_name,
                                %(Step "#{step.step_name}": the #{attached} of the line fills args.#{key}, which no claim reads, and the step has no observe to receive it, so nothing checks the value the line states. Compare a claim with "#{key}", or take the #{attached} off the line),
                                Codes.fix("claim-sentence-unread"), nil)
      end

      # The args keys a step's claims read: the head of each actual path, a
      # sentence key named as an expected value, and the head of a from
      # expected path, in every claim and in each each's where and claims.
      #: (Array[Hash[Symbol, untyped]]) -> Array[String]
      def claim_keys_read(claims)
        head = ->(path) { path.to_s.split(".").first.to_s }
        expected = lambda do |value|
          if value.is_a?(String) then value
          elsif value.is_a?(Hash) && value[:from] then head.(value[:from])
          end
        end
        claims.flat_map do |claim|
          items = claim[:each] ? [*(claim[:each][:where] || []), *claim[:each][:claims]] : [claim]
          [head.(claim[:actual]), *items.map { expected.(_1[:expected]) }]
        end.compact.uniq
      end

      # The table or docstring fills the one required key no capture and no
      # from speaks for, so zero or two such keys, or a key of a type the
      # attachment can never be, fail binding with certainty.
      #: (Scenario, PickleStep, singleton(Step), Hash[String, untyped]) -> void
      def check_fill(scenario, line, step, captures)
        missing = step.args.required_names - captures.keys - step.from.keys
        if line.table || line.doc_string
          if missing.size != 1
            detail = missing.empty? ? "every args key is already consumed by named captures or declared from" : "#{missing.size} args keys are left unconsumed (#{missing.join(", ")}); exactly one is required"
            findings << Finding.new("error", "table-docstring-key-mismatch", scenario.uri, line.line, step.step_name,
                                    %(Step "#{step.step_name}" has a table/docstring attached but #{detail}), Codes.fix("table-docstring-key-mismatch"), nil)
          else
            check_unread(scenario, line, step, missing.first.to_s)
            if (message = attachment_mismatch(step, missing.first, line))
              findings << Finding.new("error", "table-docstring-key-mismatch", scenario.uri, line.line, step.step_name, message, Codes.fix("table-docstring-key-mismatch"), nil)
            end
          end
          return
        end
        missing.each do |key|
          findings << Finding.new("error", "unfillable-required-key", scenario.uri, line.line, step.step_name,
                                  %(Step "#{step.step_name}"'s args key "#{key}" is required, but nothing on this line can fill it: no named capture in the matched pattern binds it, there is no table/docstring attachment that resolves to filling it, and it has no declared from.#{key}. This line would fail args validation with certainty. Fix one of: add a named capture for "#{key}" to the step's pattern; attach a table/docstring that fills it; declare from.#{key}; or make "#{key}" optional in the step's args schema),
                                  Codes.fix("unfillable-required-key"), nil)
        end
      end

      # An is-a claim whose expected sentence key this line fills, through a
      # capture, with a name that is no kind breaks on this line for certain.
      # Only a plain string key read as it is or as text counts, so the value
      # the claim reads is the captured text.
      #: (Scenario, PickleStep, singleton(Step), Hash[String, untyped]) -> void
      def check_kinds(scenario, line, step, captures)
        (step.claims || []).each_with_index do |claim, index|
          label = "claims[#{index}]"
          entries = [[label, claim]] #: Array[[String, Hash[Symbol, untyped]]]
          if (each = claim[:each])
            entries = [*(each[:where] || []).each_with_index.map { ["#{label}.each.where[#{_2}]", _1] },
                       *each[:claims].each_with_index.map { ["#{label}.each.claims[#{_2}]", _1] }]
          end
          entries.each do |entry_label, entry|
            key = entry[:expected]
            next unless entry[:compare] == "is-a" && key.is_a?(String) && [nil, "text"].include?(entry[:expected_view])

            named = captures[key]
            next unless named.is_a?(String) && step.args[key]&.type == :string && Claims.value_kind(named).nil?

            findings << Finding.new("error", "claim-kind-unknown", scenario.uri, line.line, step.step_name,
                                    %(Step "#{step.step_name}"'s #{entry_label}.expected is args.#{key}, which this line fills with #{JSON.generate(named)}, and is-a names one of the kinds #{Claims::VALUE_KINDS.join(", ")}, so the claim would always break),
                                    Codes.fix("claim-kind-unknown"), nil)
          end
        end
      end

      # A fits-aria-snapshot claim whose expected sentence key this line
      # fills, through a capture or the docstring, with a tree the run breaks
      # the claim on whatever the page shows: one that does not read, or one
      # that names no node.
      #: (Scenario, PickleStep, singleton(Step), Hash[String, untyped]) -> void
      def check_unfit_trees(scenario, line, step, captures)
        claims = step.claims or return
        docstring_keys = line.doc_string ? step.args.required_names - captures.keys - step.from.keys.map(&:to_s) : []
        claims.each_with_index do |claim, index|
          key = claim[:expected]
          next if claim[:each] || claim[:compare] != "fits-aria-snapshot" || !key.is_a?(String)

          captured = captures[key].is_a?(String) && step.args[key]&.type == :string ? captures[key] : nil
          text = (captured || (docstring_keys == [key] ? line.doc_string : nil)) #: String?
          next if text.nil?

          problem = AriaSnapshot.expected_problem(text) or next
          code = problem.first == :unreadable ? "claim-aria-snapshot-unreadable" : "claim-aria-snapshot-names-nothing"
          findings << Finding.new("error", code, scenario.uri, line.line, step.step_name,
                                  %(Step "#{step.step_name}"'s claims[#{index}].expected is args.#{key}, which this line's #{captured ? "capture" : "docstring"} fills, and #{AriaSnapshot.problem_reason(problem)}, so the claim would break whatever the page shows),
                                  Codes.fix(code), nil)
        end
      end

      #: (singleton(Step), String, PickleStep) -> String?
      def attachment_mismatch(step, key, line)
        field = step.args[key] or return nil
        type = field.type
        kind = case type
               in Schema then "object"
               in [:array, *] then "array"
               in :number | :integer then "number"
               in :boolean then "boolean"
               else type.to_s
               end
        if line.table && type == :string
          %(Step "#{step.step_name}" has a table attached, which fills args key "#{key}" as an array of rows (string[][]), but "#{key}" is a string. This line would fail args validation with certainty)
        elsif line.doc_string && %w[array number boolean object].include?(kind)
          %(Step "#{step.step_name}" has a docstring attached, which fills args key "#{key}" as a string, but "#{key}" is a #{kind}. This line would fail args validation with certainty)
        end
      end
    end

    #: (Array[singleton(Step)], String) -> Array[[singleton(Step), Hash[String, untyped]]]
    def self.matches(steps, text)
      steps.filter_map { |step| (captures = step.patterns.lazy.filter_map { Pattern.new(_1).match(text) }.first) && [step, captures] }
    end
  end
end
