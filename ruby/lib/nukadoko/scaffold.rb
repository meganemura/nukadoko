# frozen_string_literal: true

require "fileutils"
require "prism"
require "cucumber/cucumber_expressions/cucumber_expression_generator"

# `nuka scaffold`: a step file a person fills in, written in the TypeScript
# engine's terms. `nuka scaffold <name> --pattern <p> [--then]` writes one
# stub; `nuka scaffold --feature <path>` writes one per line no step
# matches, read as a pattern by cucumber-expressions' own generator, and
# names each from the pattern's literal words. A stub's body raises
# "not implemented: <name>" until someone writes it, so a run of it fails
# instead of passing.
#
# The Ruby engine has no `--command`, `--request`, or `--from` stub yet, so
# it refuses them rather than writing a stub that silently lacks them. A
# step's class name comes from its file name (how `load_steps` autoloads
# it), so a name whose class would not be a new Ruby constant is refused.
module Nukadoko
  module Engine
    class Scaffold
      VALID_NAME = /\A[a-z0-9-]+\z/
      NAME_LIMIT = 60
      NAMED = /\{([^{}:]*)(?::([^{}]*))?\}/
      DESCRIPTION_TODO = "TODO: describe"
      CAPTURED = { "int" => :number, "float" => :number, "string" => :string, "word" => :string }.freeze
      ATTACHMENT = { "docstring" => "string :docstring", "table" => "table :table" }.freeze
      LITERAL_WORDS = { "no" => [0, "", []], "none" => [0, "", []], "nothing" => [0, "", []], "neither" => [0, "", []],
                        "never" => [0], "empty" => ["", []] }.freeze
      NUMBER_WORDS = %w[zero one two three four five six seven eight nine ten eleven twelve].freeze
      TIMES_WORDS = { "once" => 1, "twice" => 2 }.freeze
      STATES_NO_VALUE = "a Then step's claim compares what the step reads with a value the line states, and this pattern captures none " \
                        "and holds no word that states one (no, none, nothing, neither, never, empty, once, twice, or a number word from zero to twelve)"
      LITERAL_FIX = "Chain the value the line checks with --from <step>.<key> from a step whose returns declares it as z.string(), z.number(), " \
                    "or z.array(), or capture the value in --pattern, and scaffold again."
      REDO_HEADER = "next: redo a stub in place with its line below, adding --command, --request, --from, or --description; " \
                    "--replace overwrites the stub while nobody has edited it:"
      UNPORTED = %w[--command --request --from --cwd --body --argv].freeze

      Capture = Data.define(:key, :type)

      def self.refusal(message, code = "invalid-value", **hint) = Refusal.new(code, message, **hint)

      # The captures of `pattern`, or the reason no step could hold it.
      def self.read_pattern(pattern)
        return refusal("Refusing to scaffold: the pattern is empty") if pattern.empty?

        captures = []
        rest = pattern.gsub(/\\./, "")
        open = rest.index("{")
        while open
          close = rest.index("}", open)
          return refusal(%(Refusing to scaffold: Pattern has an unterminated "{" starting at: #{rest[open..]})) unless close

          key, type = rest[open + 1...close].split(":", 2)
          return refusal(%(Refusing to scaffold: Parameter "{#{key}}" has no name; every parameter in a pattern must be written {key:type} (docs/spec.md "Typed steps"))) unless type

          captures << Capture.new(key, type)
          open = rest.index("{", close)
        end
        repeated = captures.map(&:key).tally.select { _2 > 1 }.keys
        return refusal("Refusing to scaffold: the pattern captures #{repeated.map { %("#{_1}") }.join(", ")} more than once, and one args field holds one value") if repeated.any?

        types = Pattern::REGISTRY.parameter_types.map(&:name).reject(&:empty?).sort
        unknown = captures.map(&:type).uniq.find { !types.include?(_1) }
        if unknown
          return refusal(%(Refusing to scaffold: the pattern names type "#{unknown}", and this project registers none by that name; registered types: #{types.join(", ")}))
        end

        begin
          Pattern.new(pattern)
        rescue StandardError => e
          return refusal("Refusing to scaffold: #{e.message}")
        end
        captures
      end

      # The class `load_steps` autoloads from the step's file.
      def self.class_name(name) = name.split("-").map(&:capitalize).join

      def self.class_refusal(name)
        constant = class_name(name)
        return "#{constant} is not a Ruby constant" unless constant.match?(/\A[A-Z]\w*\z/)

        existing = Object.const_defined?(constant, false) && !Object.autoload?(constant) && Object.const_get(constant)
        "#{constant} is already a Ruby constant that is not a step" if existing && !(existing.is_a?(Class) && existing < Step)
      end

      def self.file_of(name) = File.join("features", "steps", "#{name.tr("-", "_")}.rb")

      # --- the stub ---

      def self.ruby(text) = text.inspect

      def self.field_line(capture)
        type = CAPTURED.fetch(capture.type, :string)
        "#{type} :#{capture.key}"
      end

      def self.template(name:, pattern:, captures:, then_step:, attachment:, description:)
        fields = captures.map { field_line(_1) } + [ATTACHMENT[attachment]].compact
        keys = captures.map(&:key) + [attachment].compact
        args = case fields.size
               when 0 then []
               when 1 then ["  args { #{fields.first} }"]
               else ["  args do", *fields.map { "    #{_1}" }, "  end"]
               end
        lines = [
          "# frozen_string_literal: true",
          "",
          "class #{class_name(name)} < Nukadoko::Step",
          "  description #{ruby(description || "#{DESCRIPTION_TODO} #{name}")}",
          pattern ? "  pattern #{ruby(pattern)}" : '  # pattern "the feature line this step matches" (without one, the step is called by name only)',
          "  # Give each field a description: `nuka describe` shows it to whoever picks this step.",
          *args
        ]
        lines += then_step ? then_lines(name, keys) : when_lines(name, keys)
        [*lines, "end", ""].join("\n")
      end

      def self.when_lines(name, keys)
        message = keys.empty? ? ruby("not implemented: #{name}") : %("not implemented: #{name}; args \#{JSON.generate(args.to_h)}")
        [
          "  # Return what later steps cite and the values this step's correctness rests on;",
          '  # beside an absence (false, 0, ""), return proof the read was valid. Declare them here:',
          "  # returns { ... }",
          "",
          "  def run(args:)",
          "    raise #{message}",
          "  end"
        ]
      end

      # The expected value is the first one the line states; observe raises
      # until someone writes the reading, so the step records as unobserved
      # instead of passing.
      def self.then_lines(name, keys)
        actual = "actual"
        actual = actual.succ while keys.include?(actual)
        [
          "  claims [{ actual: #{ruby(actual)}, compare: \"equal\", expected: #{ruby(keys.first)} }]",
          "",
          "  # TODO: read the value this line checks and return it as { #{actual}: }, or take it",
          "  # from an earlier step's returns through `from` and remove observe.",
          "  def observe(args:)",
          "    raise #{ruby("not implemented: #{name}")}",
          "  end"
        ]
      end

      # Whether `source` is a stub this command writes for `name`: some
      # reading of its own pattern and description draws it byte for byte.
      def self.unedited?(source, name)
        pattern = literal(source, "pattern")
        description = literal(source, "description")
        return false if description.nil? || pattern == false

        captures = pattern ? read_pattern(pattern) : []
        return false if captures.is_a?(Refusal)

        [false, true].product([nil, "docstring", "table"]).any? do |then_step, attachment|
          next false if then_step && !states_value?(pattern, captures, attachment)

          template(name: name, pattern: pattern, captures: captures, then_step: then_step, attachment: attachment,
                   description: description == "#{DESCRIPTION_TODO} #{name}" ? nil : description) == source
        end
      end

      # The string a `  <call> "..."` line passes, nil when there is no such
      # line, false when the line holds something else.
      def self.literal(source, call)
        line = source[/^  #{call} (".*")$/, 1] or return nil
        node = Prism.parse(line).value.statements.body.first
        node.is_a?(Prism::StringNode) ? node.unescaped : false
      end

      # --- Then lines and the words that state a value ---

      def self.words(pattern)
        return [] unless pattern

        pattern.split(/\s+/).filter_map do |word|
          next if word.match?(/(?<!\\)[{(\/]/)

          text = word.gsub(/\\(.)/, '\1').gsub(/\A[.,;:!?"'`]+|[.,;:!?"'`]+\z/, "")
          text unless text.empty?
        end
      end

      # Each word of the pattern that states a literal, with its values.
      def self.literal_words(pattern)
        fixed = words(pattern)
        fixed.each_with_index.filter_map do |word, index|
          lower = word.downcase
          number = NUMBER_WORDS.index(lower) || TIMES_WORDS[lower]
          next [word, [number]] if number
          next unless LITERAL_WORDS.key?(lower)
          next if lower == "neither" && fixed.drop(index + 1).any? { _1.downcase == "nor" }

          [word, LITERAL_WORDS[lower]]
        end
      end

      def self.states_value?(pattern, captures, attachment) = captures.any? || attachment || literal_words(pattern).any?

      # Without a chained value no word's literal has a JSON type to pick.
      def self.literal_refusal(pattern, captures, attachment)
        return nil if captures.any? || attachment

        word, values = literal_words(pattern).first
        return nil unless word

        shown = values.map { JSON.generate(_1) }
        listed = shown.size == 1 ? shown.first : "#{shown[0...-1].join(", ")} or #{shown.last}"
        %(the line states its value only with the word "#{word}", which fixes #{listed}, and no --from names the value it is compared with, ) +
          "so that value's JSON type is unknown; a literal of another JSON type would never hold"
      end

      # --- one stub ---

      def initialize(project, options, rest, steps, scenarios)
        @project = project
        @options = options
        @rest = rest
        @steps = steps
        @scenarios = scenarios
      end

      # The paths written, and the lines for stderr, or a Refusal.
      def call
        unported = UNPORTED.find { @options.key?(_1) }
        if unported
          return Scaffold.refusal("Refusing to scaffold: #{unported} is not in the Ruby engine yet; scaffold without it and write that part of the step by hand",
                                  "invalid-arguments")
        end
        return feature(@options["--feature"].last) if @options.key?("--feature")

        single
      end

      def single
        name = @rest.first.to_s
        return Scaffold.refusal(%(Invalid step name "#{name}": must match [a-z0-9-]+ (kebab-case; it becomes the step's file name))) unless name.match?(VALID_NAME)

        why = Scaffold.class_refusal(name)
        return Scaffold.refusal(%(Invalid step name "#{name}": the Ruby engine names the step's class after it, and #{why})) if why

        description = @options["--description"].last
        if description == ""
          return Scaffold.refusal("Refusing to scaffold: --description is empty; say what the step does, or leave the flag out for a TODO that nuka check reports")
        end

        pattern = @options["--pattern"].last
        captures = pattern ? Scaffold.read_pattern(pattern) : []
        return captures if captures.is_a?(Refusal)

        relative = Scaffold.file_of(name)
        path = File.join(@project, relative)
        if File.exist?(path)
          unedited = Scaffold.unedited?(File.read(path), name)
          remove = { fix: "Delete #{relative} if it holds no step to keep, then run the same command again; or choose another step name." }
          unless @options.key?("--replace")
            return Scaffold.refusal("Refusing to scaffold: #{relative} already exists", "file-exists", **remove) unless unedited

            return Scaffold.refusal("Refusing to scaffold: #{relative} already exists, and it still holds what scaffold wrote", "file-exists",
                                    run: [*%w[nuka scaffold], *@argv_words, "--replace"].join(" "))
          end
          unless unedited
            return Scaffold.refusal("Refusing to scaffold: #{relative} is not what scaffold writes (someone edited it, or scaffold did not write it), so --replace leaves it",
                                    "file-edited", **remove)
          end
        end

        then_step = @options.key?("--then")
        attachment = pattern && attachment_in_features(pattern)
        if then_step && !Scaffold.states_value?(pattern, captures, attachment)
          return Scaffold.refusal("Refusing to scaffold: --then: #{STATES_NO_VALUE}",
                                  fix: 'Capture the value the line checks in --pattern, such as "the count is {count:int}", or write a feature line with a docstring or a table, and scaffold again.')
        end
        literal = then_step && Scaffold.literal_refusal(pattern, captures, attachment)
        return Scaffold.refusal("Refusing to scaffold: --then: #{literal}", fix: LITERAL_FIX) if literal

        write(relative, Scaffold.template(name: name, pattern: pattern, captures: captures, then_step: then_step, attachment: attachment, description: description))
        [[relative], []]
      end

      # The command line after `nuka scaffold`, as typed, for a refusal's do.
      attr_writer :argv_words

      # --- --feature ---

      def feature(target)
        paths = target_paths(target)
        return paths if paths.is_a?(Refusal)

        broken = @steps.size - Check.new(@steps, []).usable.size
        if broken.positive?
          return Scaffold.refusal("Refusing to scaffold: #{broken} step file(s) did not import, so which lines are undefined is not known (a line may belong to a step in one of them)",
                                  "step-file-import-failed", run: "nuka check")
        end

        usable = Check.new(@steps, []).usable
        selected = Dir.chdir(@project) { Engine.load_features(paths) }
        undefined = selected.flat_map { |scenario| scenario.steps.map { [scenario, _1] } }
                            .select { |_, line| Engine.matches(usable, line.text).empty? }
        return [[], ["nothing to scaffold: every line in #{target} matches a step"]] if undefined.empty?

        project_lines = (@scenarios + selected).flat_map { |scenario| scenario.steps.map { ["#{scenario.uri}:#{_1.line}", _1.text] } }
        reading = undefined.map { _2.text }.uniq.to_h { [_1, Scaffold.infer(_1)] }
        notes = []
        planned = {}
        undefined.group_by { |scenario, line| "#{scenario.uri}:#{line.line}" }.each do |where, group|
          texts = group.map { _2.text }.uniq
          patterns = texts.map { reading[_1][:pattern] }.uniq
          if patterns.size > 1
            notes << "#{where}: its Examples rows read as different patterns (#{patterns.map { JSON.generate(_1) }.join(", ")}), so no stub was written; " \
                     'scaffold it with nuka scaffold <name> --pattern "<line with {key:type} captures>"'
            next
          end
          read = reading[texts.first]
          pattern = read[:pattern]
          if read[:readings]
            notes << %(#{where}: "#{texts.first}" reads as #{read[:readings].map { JSON.generate(_1) }.join(" or ")}, so the stub's pattern is the line as written, ) +
                     "with no capture; put a {key:type} capture in it by hand"
          elsif pattern.match?(NAMED)
            other = project_lines.find { |_, text| reading.dig(text, :pattern) != pattern && Pattern.new(pattern).match(text) }
            if other
              if texts.size > 1
                notes << "#{where}: its pattern #{JSON.generate(pattern)} would also match \"#{other[1]}\" (#{other[0]}), and its Examples rows have no single line " \
                         "to write instead, so no stub was written"
                next
              end
              pattern = Scaffold.literal_pattern(texts.first)
              notes << "#{where}: #{JSON.generate(read[:pattern])} would also match \"#{other[1]}\" (#{other[0]}), so the stub's pattern is the line as written, with no capture"
            end
          end
          (planned[pattern] ||= []).concat(group)
        end

        taken = usable.map(&:step_name)
        written = []
        redos = []
        planned.each do |pattern, lines|
          name = distinct(Scaffold.name_for(pattern)) { |candidate| taken.include?(candidate) || File.exist?(File.join(@project, Scaffold.file_of(candidate))) || Scaffold.class_refusal(candidate) }
          where = "#{lines.first[0].uri}:#{lines.first[1].line}"
          then_step = lines.any? { _2.kind.to_s == "Outcome" }
          kinds = lines.map { attachment_of(_2) }.uniq
          attachment = kinds.size == 1 ? kinds.first : nil
          captures = Scaffold.read_pattern(pattern)
          if then_step && !Scaffold.states_value?(pattern, captures, attachment)
            notes << "#{where}: #{STATES_NO_VALUE}, so no stub was written; state the value this line checks in the line, such as a number or a quoted text, and scaffold again"
            next
          end
          literal = then_step && Scaffold.literal_refusal(pattern, captures, attachment)
          if literal
            notes << "#{where}: #{literal}, so no stub was written; scaffold it alone with --then --from <step>.<key>, naming a value its step's returns " \
                     "declares as z.string(), z.number(), or z.array()"
            next
          end
          taken << name
          relative = Scaffold.file_of(name)
          source = Scaffold.template(name: name, pattern: pattern, captures: captures, then_step: then_step, attachment: attachment, description: nil)
          write(relative, source)
          written << relative
          again = Scaffold.template(name: name, pattern: pattern, captures: captures, then_step: then_step, attachment: attachment_in_features(pattern), description: nil)
          redos << ["nuka", "scaffold", name, "--pattern", pattern, *("--then" if then_step), "--replace"].map { Selection.shell_word(_1) }.join(" ") if again == source
        end
        err = notes.map { "note: #{_1}" }
        err += [REDO_HEADER, *redos.map { "  #{_1}" }] if redos.any?
        [written, err]
      end

      # How cucumber-expressions reads a line: with captures when every
      # reading hands the step the same kind of value, otherwise as the line
      # itself, with the readings it could not choose between.
      def self.infer(text)
        generated = generate(text, Pattern::REGISTRY)
        first = generated.first
        same = generated.all? do |expression|
          expression.parameter_types.size == first.parameter_types.size &&
            expression.parameter_types.zip(first.parameter_types).all? { |a, b| a.name == b.name || (CAPTURED[a.name] && CAPTURED[a.name] == CAPTURED[b.name]) }
        end
        pattern = name_captures(first.source)
        matched = begin
          Pattern.new(pattern).match(text)
        rescue StandardError
          nil
        end
        return { pattern: pattern } if same && matched

        { pattern: literal_pattern(text), readings: generated.map(&:source) }
      end

      # The generator escapes `(`, `{`, and `/` but leaves a backslash bare,
      # which the parser then refuses, so each backslash is doubled first.
      def self.generate(text, registry)
        Cucumber::CucumberExpressions::CucumberExpressionGenerator.new(registry).generate_expressions(text.gsub("\\", "\\\\\\\\"))
      end

      # The line as a pattern that matches it and nothing else.
      def self.literal_pattern(text) = text.gsub("\\", "\\\\\\\\").gsub(/([({\/])/) { "\\#{Regexp.last_match(1)}" }

      def self.name_captures(source)
        index = 0
        source.gsub(/\\.|\{([^}]*)\}/) do |match|
          next match if match.start_with?("\\")

          key = index.zero? ? "value" : "value#{index + 1}"
          index += 1
          "{#{key}:#{Regexp.last_match(1)}}"
        end
      end

      def self.name_for(pattern)
        literal = pattern.gsub(/\\(.)|\{[^}]*\}/) { Regexp.last_match(1) || " " }
        words = literal.downcase.gsub(/[^a-z0-9]+/, "-").gsub(/\A-+|-+\z/, "")
        return "step" if words.empty?
        return words if words.size <= NAME_LIMIT

        cut = words[0, NAME_LIMIT + 1]
        dash = cut.rindex("-")
        (dash&.positive? ? cut[0, dash] : cut[0, NAME_LIMIT]).sub(/-+\z/, "")
      end

      private

      def distinct(base)
        return base unless yield(base)

        suffix = 2
        suffix += 1 while yield("#{base}-#{suffix}")
        "#{base}-#{suffix}"
      end

      def attachment_of(line) = line.doc_string ? "docstring" : (line.table ? "table" : nil)

      # What every feature line the pattern matches carries, or nil when no
      # line matches or the lines disagree.
      def attachment_in_features(pattern)
        expression = Pattern.new(pattern)
        kinds = @scenarios.flat_map(&:steps).select { expression.match(_1.text) }.map { attachment_of(_1) }.uniq
        kinds.size == 1 ? kinds.first : nil
      rescue StandardError
        nil
      end

      def target_paths(target)
        absolute = File.join(@project, target)
        return Dir.glob("**/*.feature", base: absolute).sort.map { File.join(target, _1) } if File.directory?(absolute)
        return [target] if File.file?(absolute)

        Scaffold.refusal("nuka scaffold --feature: feature file not found: #{target}", "target-not-found")
      end

      def write(relative, source)
        path = File.join(@project, relative)
        FileUtils.mkdir_p(File.dirname(path))
        File.write(path, source)
      end
    end
  end
end
