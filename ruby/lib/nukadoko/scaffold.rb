# frozen_string_literal: true
# rbs_inline: enabled

require "fileutils"
require "pathname"
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
# `--command <entry point>` writes a When step that runs the program under
# Ruby in an empty scratch directory and returns its exitCode, stdout, and
# stderr; `--request "<METHOD> <path>"` one that sends a request through the
# `request` fixture and returns its status and body; and `--from
# <step>.<key>` the chain to an earlier step's returns, read from that
# step's own declaration so the two cannot drift apart. A Then step with one
# stated and one chained value gets a whole claim, so a feature about a
# program runs green with no hand edit. A step's class name comes from its
# file name (how `load_steps` autoloads it), so a name whose class would not
# be a new Ruby constant is refused.
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

      Capture = Data.define(
        :key, #: String
        :type, #: String
      )

      #: (String, ?String, **untyped) -> Refusal
      def self.refusal(message, code = "invalid-value", **hint) = Refusal.new(code, message, **hint)

      # The captures of `pattern`, or the reason no step could hold it.
      #: (String) -> (Array[Capture] | Refusal)
      def self.read_pattern(pattern)
        return refusal("Refusing to scaffold: the pattern is empty") if pattern.empty?

        captures = []
        rest = pattern.gsub(/\\./, "")
        open = rest.index("{")
        while open
          close = rest.index("}", open)
          return refusal(%(Refusing to scaffold: Pattern has an unterminated "{" starting at: #{rest[open..]})) unless close

          key, type = rest[open + 1...close].to_s.split(":", 2)
          return refusal(%(Refusing to scaffold: Parameter "{#{key}}" has no name; every parameter in a pattern must be written {key:type} (docs/spec.md "Typed steps"))) unless type

          captures << Capture.new(key.to_s, type)
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
      #: (String) -> String
      def self.class_name(name) = name.split("-").map(&:capitalize).join

      #: (String) -> String?
      def self.class_refusal(name)
        constant = class_name(name)
        return "#{constant} is not a Ruby constant" unless constant.match?(/\A[A-Z]\w*\z/)

        existing = Object.const_defined?(constant, false) && !Object.autoload?(constant) && Object.const_get(constant)
        "#{constant} is already a Ruby constant that is not a step" if existing && !(existing.is_a?(Class) && existing < Step)
      end

      #: (String) -> String
      def self.file_of(name) = File.join("features", "steps", "#{name.tr("-", "_")}.rb")

      # --- the stub ---

      ENTRY_POINT_PLACEHOLDER = "<TODO: the entry point>"
      SENT_METHODS = %w[GET POST PUT PATCH DELETE].freeze
      # Neither a capture nor a docstring can end with the newline a program
      # prints last, so a claim on one of these compares its text view.
      OUTPUT_STREAMS = %w[stdout stderr].freeze

      # One args key the template writes: `kind` is the class of the value
      # it holds ("string", "number", or "other") and `json` its JSON type
      # ("string", "number", "array", or nil when that is not known).
      Field = Data.define(
        :key, #: String
        :kind, #: String
        :json, #: String?
      )

      # One args key `from` fills, with every step that can give it, by
      # class name, and the type the first of them declares.
      Chained = Data.define(
        :key, #: String
        :producers, #: Array[String]
        :type, #: untyped
      )

      #: (String) -> String
      def self.ruby(text) = text.inspect

      #: (Capture) -> String
      def self.field_line(capture)
        type = CAPTURED.fetch(capture.type, :string)
        "#{type} :#{capture.key}"
      end

      #: (Capture) -> Field
      def self.capture_field(capture)
        kind = CAPTURED[capture.type]&.to_s || "other"
        Field.new(capture.key, kind, kind == "other" ? nil : kind)
      end

      #: (String) -> Field
      def self.attachment_field(attachment) = attachment == "docstring" ? Field.new("docstring", "string", "string") : Field.new("table", "other", "array")

      # Only a bare string or number counts as one: a nullable one may hold
      # no value of that type at all.
      #: (Chained) -> Field
      def self.chained_field(chained)
        type = chained.type
        kind = type == :string ? "string" : (%i[number integer].include?(type) ? "number" : "other")
        json = kind == "other" ? (type.is_a?(Array) && type.first == :array ? "array" : nil) : kind
        Field.new(chained.key, kind, json)
      end

      # `<METHOD> <path>` as [method, segments], each segment a String sent
      # as it is or a Symbol naming an args key; nil when it is neither.
      #: (String) -> [String, Array[String | Symbol]]?
      def self.read_request(text)
        parts = /\A([A-Z]+) (\S+)\z/.match(text) or return nil
        path = parts[2].to_s
        segments = [] #: Array[String | Symbol]
        path.scan(/\{([A-Za-z_]\w*)\}|([^{}]+)/) { segments << ((key = Regexp.last_match(1)) ? key.to_sym : Regexp.last_match(2).to_s) }
        return nil unless segments.map { _1.is_a?(Symbol) ? "{#{_1}}" : _1 }.join == path

        [parts[1].to_s, segments]
      end

      #: ([String, Array[String | Symbol]]) -> String
      def self.request_text(request) = "#{request[0]} #{request[1].map { _1.is_a?(Symbol) ? "{#{_1}}" : _1 }.join}"

      # The path as a Ruby string literal, each key's value put in its place.
      #: (Array[String | Symbol]) -> String
      def self.path_literal(segments)
        %("#{segments.map { _1.is_a?(Symbol) ? "\#{args.#{_1}}" : ruby(_1)[1...-1] }.join}")
      end

      #: (name: String, pattern: String?, captures: Array[Capture], then_step: bool, attachment: String?, description: String?, ?variant: String?, ?entry: String?, ?cwd: String?, ?argv: String?, ?request: [String, Array[String | Symbol]]?, ?body: String?, ?chained: Array[Chained]) -> String
      def self.template(name:, pattern:, captures:, then_step:, attachment:, description:, variant: nil, entry: nil, cwd: nil, argv: nil, request: nil, body: nil,
                        chained: [])
        command = variant == "command"
        sends = variant == "request"
        stated = captures.map { capture_field(_1) } + [attachment].compact.map { attachment_field(_1) }
        from_fields = chained.map { chained_field(_1) }
        fields = captures.map { field_line(_1) } + [ATTACHMENT[attachment]].compact + chained.map { "field :#{_1.key}, #{_1.producers.first}.returns[:#{_1.key}]" }
        keys = (stated + from_fields).map(&:key)
        args = case fields.size
               when 0 then []
               when 1 then ["  args { #{fields.first} }"]
               else ["  args do", *fields.map { "    #{_1}" }, "  end"]
               end
        sources = chained.map do |link|
          candidates = link.producers.map { "[#{_1}, :#{link.key}]" }
          "#{link.key}: #{candidates.size == 1 ? candidates.first : "[#{candidates.join(", ")}]"}"
        end
        described = description || default_description(name, variant, cwd, argv, request)
        lines = [
          "# frozen_string_literal: true",
          "",
          "class #{class_name(name)} < Nukadoko::Step",
          *(command ? ["  CLI = File.expand_path(#{ruby(entry || ENTRY_POINT_PLACEHOLDER)})", ""] : []),
          "  description #{ruby(described)}",
          pattern ? "  pattern #{ruby(pattern)}" : '  # pattern "the feature line this step matches" (without one, the step is called by name only)',
          "  # Give each field a description: `nuka describe` shows it to whoever picks this step.",
          *args,
          *(sources.empty? ? [] : ["  from #{sources.join(", ")}"])
        ]
        lines += if then_step then then_lines(name, pattern, keys, stated, from_fields)
                 elsif command then command_lines(name, entry, cwd, argv, captures.map { capture_field(_1) }, from_fields)
                 elsif sends && request then request_lines(name, request, body, stated + from_fields)
                 else when_lines(name, keys)
                 end
        [*lines, "end", ""].each_with_index.map { |line, index| line.sub(LINE_MARKER, (index + 1).to_s) }.join("\n")
      end

      # Stands for the 1-based number of the line that holds it, filled in
      # once the whole file is assembled.
      LINE_MARKER = "\u0000line"

      #: (String, String?, String?, String?, [String, Array[String | Symbol]]?) -> String
      def self.default_description(name, variant, cwd, argv, request)
        case variant
        when "command"
          where = cwd ? "in the directory #{cwd} names" : "in an empty scratch directory"
          "Run the command under test #{where}#{", with #{argv} split on whitespace into its arguments" if argv}"
        when "request" then request ? "Send #{request_text(request)} and return the response's status and body" : "#{DESCRIPTION_TODO} #{name}"
        else "#{DESCRIPTION_TODO} #{name}"
        end
      end

      #: (String, Array[String]) -> Array[String]
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

      # The guard a step raises while a value has nowhere to go yet. The
      # values are in its message, so the first failed run shows what was
      # bound.
      #: (String, Array[Field], String) -> Array[String]
      def self.unplaced_guard(name, unplaced, reader)
        keys = unplaced.map(&:key)
        todo = if reader == "program"
                 ["    # TODO: pass each chained value where the program reads it: an environment",
                  "    # variable (run_command's env:), a flag, or --cwd. Then delete the raise."]
               else
                 ["    # TODO: pass each value where the request reads it: the path, or the",
                  "    # request's data:, body:, or headers:. Then delete the raise."]
               end
        values = keys.map { "#{_1}: args.#{_1}" }.join(", ")
        [*todo, %(    raise "pass #{keys.join(", ")} where the #{reader} reads them: #{file_of(name)}:#{LINE_MARKER}; args \#{JSON.generate({ #{values} })}")]
      end

      #: (String, String?, String?, String?, Array[Field], Array[Field]) -> Array[String]
      def self.command_lines(name, entry, cwd, argv, captured, chained)
        argv_words = captured.reject { _1.key == cwd }.map do |field|
          next "*args.#{field.key}.split" if field.key == argv

          field.kind == "string" ? "args.#{field.key}" : "args.#{field.key}.to_s"
        end
        unplaced = chained.reject { _1.key == cwd }
        guard = entry ? [] : [%(    raise #{ruby("fill in the entry point: #{file_of(name)}:4")} if CLI.include?(#{ruby(ENTRY_POINT_PLACEHOLDER)}))]
        [
          "  returns do",
          "    number :exitCode, null: true",
          "    string :stdout",
          "    string :stderr",
          "  end",
          "  # Set this to false when the program changes nothing outside a scratch directory.",
          "  mutates true",
          "",
          cwd ? "  def run(args:)" : "  def run(args:, scratch:)",
          *guard,
          *(unplaced.empty? ? [] : unplaced_guard(name, unplaced, "program")),
          "    Nukadoko.run_command(RbConfig.ruby, [#{["CLI", *argv_words].join(", ")}], cwd: #{cwd ? "args.#{cwd}" : "scratch.dir"})",
          "  end"
        ]
      end

      # A text the request sends as it is; anything else as JSON.
      #: (String, [String, Array[String | Symbol]], String?, Array[Field]) -> Array[String]
      def self.request_lines(name, request, body, fields)
        method, segments = request
        placed = segments.grep(Symbol).map(&:to_s) + [body].compact
        unsent = fields.reject { placed.include?(_1.key) }
        sent = fields.find { _1.key == body }
        option = sent ? ", #{sent.kind == "string" ? "body" : "data"}: args.#{body}" : ""
        [
          "  returns do",
          "    number :status",
          "    string :body",
          "  end",
          "  # The method is no proof either way: set this to false when the request changes nothing on the server.",
          "  mutates true",
          "",
          "  def run(args:, request:)",
          *(unsent.empty? ? [] : unplaced_guard(name, unsent, "request")),
          "    response = request.#{method.downcase}(#{path_literal(segments)}#{option})",
          "    { status: response.status, body: response.body }",
          "  end"
        ]
      end

      # A Then step's claims. One stated value and one chained value make a
      # whole claim: the chained value is the actual, the stated one the
      # expected. A line that states its value with a word compares the one
      # chained value with that word's literal. Otherwise the first stated
      # value is the expected one, and observe raises until someone writes
      # the reading, so the step records as unobserved instead of passing.
      #: (String, String?, Array[String], Array[Field], Array[Field]) -> Array[String]
      def self.then_lines(name, pattern, keys, stated, chained)
        found = stated.empty? && chained.size == 1 && word_literal(pattern, chained.first&.json)
        if found
          actual = chained.first
          word, literal, compare = found
          text = OUTPUT_STREAMS.include?(actual.key) && actual.kind == "string"
          numbered = NUMBER_WORDS.include?(word.to_s.downcase) || TIMES_WORDS.key?(word.to_s.downcase)
          return [
            if numbered
              %(  # "#{word}" states #{JSON.generate(literal)}. A number word takes any compare: change equal to the one the line says ("at least three" is at-least).)
            else
              %(  # "#{word}" states #{JSON.generate(literal)} for the type #{actual.key} holds. A word's literal is compared with #{compare} alone.)
            end,
            *(text ? ["  # The program ends its output with a newline that the feature line does not show."] : []),
            "  claims [{ actual: #{ruby(actual.key)},#{" view: \"text\"," if text} compare: #{ruby(compare.to_s)}, expected: { literal: #{ruby_literal(literal)} } }]"
          ]
        end
        if stated.size == 1 && chained.size == 1
          expected = stated.first
          actual = chained.first
          text = OUTPUT_STREAMS.include?(actual.key) && actual.kind == "string" && expected.kind == "string"
          return [
            *(text ? ["  # The program ends its output with a newline that the feature line does not show."] : []),
            "  claims [{ actual: #{ruby(actual.key)},#{" view: \"text\"," if text} compare: \"equal\", expected: #{ruby(expected.key)} }]"
          ]
        end
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

      #: (untyped) -> String
      def self.ruby_literal(value) = value.is_a?(String) ? ruby(value) : JSON.generate(value)

      # The first word's literal of `json`, and the compare it takes (not-equal
      # right after a fixed `not`); nil when no word fixes a value of it.
      #: (String?, String?) -> [String, untyped, String]?
      def self.word_literal(pattern, json)
        return nil if json.nil?

        fixed = words(pattern)
        literal_words(pattern).each do |word, values|
          literal = values.find { json_of(_1) == json }
          next if literal.nil?

          index = fixed.index(word)
          negated = index&.positive? && fixed[index - 1].to_s.downcase == "not"
          return [word, literal, negated ? "not-equal" : "equal"]
        end
        nil
      end

      #: (untyped) -> String?
      def self.json_of(value)
        case value
        when Array then "array"
        when String then "string"
        when Numeric then "number"
        end
      end

      # Whether `source` is a stub this command writes for `name`: some
      # reading of its own lines draws it byte for byte. `type_of` gives the
      # type a step, by class name, returns under a key, or nil.
      #: (String, String, ?^(String, String) -> untyped) -> bool
      def self.unedited?(source, name, type_of = ->(_step, _key) {})
        pattern = literal(source, "pattern")
        description = literal(source, "description")
        return false if description.nil? || pattern == false

        text = pattern.is_a?(String) ? pattern : nil
        # A description that is no plain string draws the TODO, as nil does.
        said = description.is_a?(String) ? description : nil
        captures = text ? read_pattern(text) : []
        return false if captures.is_a?(Refusal)

        entry = literal(source, "CLI = File.expand_path", parenthesized: true)
        return false if entry == false

        request = sent_request(source)
        chained = chained_in(source, type_of)
        return false if request == false || chained.nil?

        variant = entry ? "command" : (request ? "request" : nil)
        shape = {
          variant: variant, entry: entry == ENTRY_POINT_PLACEHOLDER ? nil : entry, cwd: source[/cwd: args\.(\w+)\)$/, 1],
          argv: source[/\*args\.(\w+)\.split/, 1], request: request && request[0], body: request && request[1], chained: chained
        }
        [false, true].product([nil, "docstring", "table"]).any? do |then_step, attachment|
          next false if then_step && (variant || !states_value?(text, captures, attachment))

          template(name: name, pattern: text, captures: captures, then_step: then_step, attachment: attachment, description: said, **shape) == source
        end
      end

      # The string a `  <call> "..."` line passes, nil when there is no such
      # line, false when the line holds something else.
      #: (String, String, ?parenthesized: bool) -> (String | false | nil)
      def self.literal(source, call, parenthesized: false)
        line = (parenthesized ? source[/^  #{Regexp.escape(call)}\((".*")\)$/, 1] : source[/^  #{call} (".*")$/, 1]) or return nil
        node = Prism.parse(line).value.statements.body.first
        node.is_a?(Prism::StringNode) ? node.unescaped : false
      end

      # The request a `--request` stub sends, as [request, body key], nil
      # when it sends none, false when the line is not one scaffold writes.
      #: (String) -> ([[String, Array[String | Symbol]], String?] | false | nil)
      def self.sent_request(source)
        call = source[/^    response = request\.(?:get|post|put|patch|delete)\(.*\)$/] or return nil
        node = Prism.parse(call.strip).value.statements.body.first
        sent = node.is_a?(Prism::LocalVariableWriteNode) ? node.value : nil
        return false unless sent.is_a?(Prism::CallNode) && sent.arguments

        listed = sent.arguments or return false
        path, options = listed.arguments
        segments = case path
                   when Prism::StringNode then [path.unescaped]
                   when Prism::InterpolatedStringNode
                     path.parts.map do |part|
                       next part.unescaped if part.is_a?(Prism::StringNode)

                       inner = part.is_a?(Prism::EmbeddedStatementsNode) && part.statements&.body&.first
                       receiver = inner.receiver if inner.is_a?(Prism::CallNode)
                       return false unless inner.is_a?(Prism::CallNode) && receiver.is_a?(Prism::CallNode) && receiver.name == :args

                       inner.name
                     end
                   else return false
                   end
        body = options && source[/, (?:body|data): args\.(\w+)\)$/, 1]
        [[sent.name.to_s.upcase, segments], body]
      end

      # The `from` a stub declares, each key's producers by class name and
      # the type the first returns; nil when a producer's type is unknown.
      #: (String, ^(String, String) -> untyped) -> Array[Chained]?
      def self.chained_in(source, type_of)
        line = source[/^  from (.*)$/, 1] or return []
        found = [] #: Array[[String, String]]
        line.scan(/(\w+): (\[\[.*?\]\]|\[\w+, :\w+\])/) { found << [Regexp.last_match(1).to_s, Regexp.last_match(2).to_s] }
        found.map do |key, list|
          producers = [] #: Array[String]
          list.scan(/\[(\w+), :\w+\]/) { producers << Regexp.last_match(1).to_s }
          type = type_of.(producers.first.to_s, key) or return nil
          Chained.new(key, producers, type)
        end
      end

      # --- Then lines and the words that state a value ---

      #: (String?) -> Array[String]
      def self.words(pattern)
        return [] unless pattern

        pattern.split(/\s+/).filter_map do |word|
          next if word.match?(/(?<!\\)[{(\/]/)

          text = word.gsub(/\\(.)/, '\1').gsub(/\A[.,;:!?"'`]+|[.,;:!?"'`]+\z/, "")
          text unless text.empty?
        end
      end

      # Each word of the pattern that states a literal, with its values.
      #: (String?) -> Array[[String, Array[untyped]]]
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

      #: (String?, Array[Capture], String?) -> bool
      def self.states_value?(pattern, captures, attachment) = captures.any? || !attachment.nil? || literal_words(pattern).any?

      # A word's values differ in JSON type (`no` fixes 0, "", or []), so the
      # claim needs exactly one chained value whose type the word fixes.
      #: (String?, Array[Capture], String?, ?Array[Field]) -> String?
      def self.literal_refusal(pattern, captures, attachment, chained = [])
        return nil if captures.any? || attachment

        word, values = literal_words(pattern).first
        return nil unless word

        only = chained.size == 1 ? chained.first : nil
        return nil if only && word_literal(pattern, only.json)

        shown = values.map { JSON.generate(_1) }
        listed = shown.size == 1 ? shown.first : "#{shown[0...-1].to_a.join(", ")} or #{shown.last}"
        why = if only.nil?
                chained.empty? ? "no --from names the value it is compared with, so that value's JSON type is unknown" : "#{chained.size} --from values fill this step, so which one it is compared with is unknown"
              elsif only.json.nil?
                "--from #{only.key} is not declared as a bare z.string(), z.number(), or z.array(), so its JSON type is unknown"
              else
                "--from #{only.key} holds #{with_article(only.json)}, a type no word of the line fixes a value of"
              end
        %(the line states its value only with the word "#{word}", which fixes #{listed}, and #{why}; a literal of another JSON type would never hold)
      end

      #: (String) -> String
      def self.with_article(json) = json == "array" ? "an array" : "a #{json}"

      TYPE_FIX = "Capture the value with a parameter type of the JSON type the chained value holds ({int} or {float} for a number, {string} for a text), " \
                 "chain a value of the type the line states, or, when a word of the line states the value, take the capture out of --pattern, and scaffold again."

      # A claim across two JSON types never holds, so a line that states one
      # value and chains one of another type is refused.
      #: (String?, Array[Capture], Array[Field], Array[Field]) -> String?
      def self.type_refusal(pattern, captures, stated, chained)
        return nil unless stated.size == 1 && chained.size == 1

        line = stated.first
        only = chained.first
        return nil if line.json.nil? || only.json.nil? || line.json == only.json

        captured = captures.find { _1.key == line.key }
        what = captured ? "{#{captured.key}:#{captured.type}}" : "its #{line.key}"
        head = "the line states #{what}, #{with_article(line.json)}, and --from #{only.key} holds #{with_article(only.json)}, "
        word = word_literal(pattern, only.json)
        return "#{head}so a claim could compare #{only.key} only with the word \"#{word[0]}\", and no claim would read #{what}; a Then step with no observe checks every value its line states" if word

        "#{head}and no word of the line fixes #{with_article(only.json)}; a claim across two JSON types would never hold"
      end

      # --- one stub ---

      #: (String, Hash[String, Array[String]], Array[String], Array[singleton(Step)], Array[Scenario]) -> void
      def initialize(project, options, rest, steps, scenarios)
        @project = project
        @options = options
        @rest = rest
        @steps = steps
        @scenarios = scenarios
      end

      # The paths written, and the lines for stderr, or a Refusal.
      #: () -> ([Array[String], Array[String]] | Refusal)
      def call
        return feature(@options["--feature"].last) if @options.key?("--feature")

        single
      end

      #: () -> ([Array[String], Array[String]] | Refusal)
      def single
        name = @rest.first.to_s
        return Scaffold.refusal(%(Invalid step name "#{name}": must match [a-z0-9-]+ (kebab-case; it becomes the step's file name))) unless name.match?(VALID_NAME)

        why = Scaffold.class_refusal(name)
        return Scaffold.refusal(%(Invalid step name "#{name}": the Ruby engine names the step's class after it, and #{why})) if why

        then_step = @options.key?("--then")
        command = @options.key?("--command")
        entry = @options.fetch("--command", []).last.to_s
        entry = nil if entry.empty?
        cwd = @options.fetch("--cwd", []).last
        argv = @options.fetch("--argv", []).last
        body = @options.fetch("--body", []).last
        if command && then_step
          return Scaffold.refusal("Refusing to scaffold: --command and --then together; a step that runs a program acts, and a Then step judges through claims",
                                  "invalid-arguments")
        end
        request = nil
        if @options.key?("--request")
          if command
            return Scaffold.refusal("Refusing to scaffold: --request and --command together; one When step either sends a request or runs a program", "invalid-arguments")
          end
          if then_step
            return Scaffold.refusal("Refusing to scaffold: --request and --then together; the step that sends the request is a When, and a Then step reads its status or body with --from",
                                    "invalid-arguments")
          end
          text = @options["--request"].last.to_s
          request = Scaffold.read_request(text)
          unless request
            return Scaffold.refusal(%(Refusing to scaffold: --request takes "<METHOD> <path>", an upper-case method and a path with no space, each {key} in it an args key, ) +
                                    %(such as "GET /items/{id}", and got #{JSON.generate(text)}))
          end
          unless SENT_METHODS.include?(request[0])
            return Scaffold.refusal("Refusing to scaffold: --request's method #{request[0]} is not one the Ruby engine's request fixture sends (#{SENT_METHODS.join(", ")})")
          end
        end
        if body && request.nil?
          return Scaffold.refusal("Refusing to scaffold: --body names the args key a --request step sends, and only a --request step sends one", "invalid-arguments")
        end
        if cwd && !command
          return Scaffold.refusal("Refusing to scaffold: --cwd names the directory the program runs in, and only a --command step runs one", "invalid-arguments")
        end

        description = @options["--description"].last
        if description == ""
          return Scaffold.refusal("Refusing to scaffold: --description is empty; say what the step does, or leave the flag out for a TODO that nuka check reports")
        end

        if entry && !File.file?(File.join(@project, entry))
          looked = Pathname.new(File.expand_path(entry, @project)).relative_path_from(Pathname.new(File.expand_path(@project))).to_s
          order = @command_before_name && entry.match?(VALID_NAME) ? "; #{Scaffold.command_took_the_name(entry)}" : ""
          return Scaffold.refusal("Refusing to scaffold: entry point #{JSON.generate(entry)} is not a file (looked at #{looked}); pass the path of the program the step runs, " \
                                  "relative to the directory nuka runs in, or give --command no value to leave a TODO#{order}")
        end

        pattern = @options["--pattern"].last
        captures = pattern ? Scaffold.read_pattern(pattern) : []
        return captures if captures.is_a?(Refusal)

        links = from_links(captures)
        return links if links.is_a?(Refusal)

        keys = captures.map(&:key) + links.map(&:last).uniq
        has = keys.empty? ? "it has none" : "its keys are #{keys.join(", ")}"
        if cwd && !keys.include?(cwd)
          return Scaffold.refusal("Refusing to scaffold: --cwd #{cwd} names no args key of this step (#{has}); pass the key a --from or a capture fills")
        end
        unknown = request ? request[1].grep(Symbol).map(&:to_s).reject { keys.include?(_1) } : []
        if unknown.any?
          return Scaffold.refusal("Refusing to scaffold: --request's path names #{unknown.map { "{#{_1}}" }.join(", ")}, which no capture or --from fills (#{has}); " \
                                  "a {key} in the path is put in by that args key's value")
        end
        if argv
          refused = argv_refusal(argv, command, cwd, captures)
          return refused if refused
        end

        relative = Scaffold.file_of(name)
        path = File.join(@project, relative)
        if File.exist?(path)
          unedited = Scaffold.unedited?(File.read(path), name, type_of)
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

        chained = chain(links)
        return chained if chained.is_a?(Refusal)

        from_fields = chained.map { Scaffold.chained_field(_1) }
        cwd_field = (captures.map { Scaffold.capture_field(_1) } + from_fields).find { _1.key == cwd }
        if cwd_field && cwd_field.kind != "string"
          return Scaffold.refusal("Refusing to scaffold: --cwd #{cwd} may hold a value that is not a string, and run_command takes cwd as a string; " \
                                  "chain a key whose schema is a bare string, or capture it as {#{cwd}:string}")
        end

        # A command's docstring has no place in argv, so it stays the author's call.
        attachment = pattern && !command ? attachment_in_features(pattern) : nil
        if body
          sendable = keys + [attachment].compact
          unless sendable.include?(body)
            attached = %w[docstring table].include?(body) ? "; no feature line this pattern matches carries a #{body} (write the line first)" : ""
            return Scaffold.refusal("Refusing to scaffold: --body #{body} names no args key of this step (#{sendable.empty? ? "it has none" : "its keys are #{sendable.join(", ")}"})#{attached}")
          end
        end

        if then_step && !Scaffold.states_value?(pattern, captures, attachment)
          return Scaffold.refusal("Refusing to scaffold: --then: #{STATES_NO_VALUE}",
                                  fix: 'Capture the value the line checks in --pattern, such as "the count is {count:int}", or write a feature line with a docstring or a table, and scaffold again.')
        end
        literal = then_step && Scaffold.literal_refusal(pattern, captures, attachment, from_fields)
        return Scaffold.refusal("Refusing to scaffold: --then: #{literal}", fix: LITERAL_FIX) if literal

        stated = captures.map { Scaffold.capture_field(_1) } + [attachment].compact.map { Scaffold.attachment_field(_1) }
        typed = then_step && Scaffold.type_refusal(pattern, captures, stated, from_fields)
        return Scaffold.refusal("Refusing to scaffold: --then: #{typed}", fix: TYPE_FIX) if typed

        variant = command ? "command" : (request ? "request" : nil)
        write(relative, Scaffold.template(name: name, pattern: pattern, captures: captures, then_step: then_step, attachment: attachment, description: description,
                                          variant: variant, entry: entry, cwd: cwd, argv: argv, request: request, body: body, chained: chained))
        [[relative], []]
      end

      #: (String) -> String
      def self.command_took_the_name(value)
        "--command before the name takes the next word as its value (#{JSON.generate(value)} here); write the name first, or give --command a value"
      end

      # The command line after `nuka scaffold`, as typed, for a refusal's do.
      attr_writer :argv_words #: Array[String]
      # Whether `--command <value>` came before the name, so a name typed
      # right after the flag was read as its value.
      attr_writer :command_before_name #: bool

      private

      # Each `--from` as [step, key], or the reason one cannot be.
      #: (Array[Capture]) -> (Array[[String, String]] | Refusal)
      def from_links(captures)
        keys = captures.map(&:key)
        links = [] #: Array[[String, String]]
        @options.fetch("--from", []).each do |text|
          parts = /\A([a-z0-9-]+)\.([A-Za-z_]\w*)\z/.match(text)
          return Scaffold.refusal("Refusing to scaffold: --from takes <step>.<key>, a step name and one identifier, and got #{JSON.generate(text)}") unless parts

          step, key = parts[1].to_s, parts[2].to_s
          if keys.include?(key) && links.none? { _2 == key }
            return Scaffold.refusal(%(Refusing to scaffold: args key "#{key}" is filled by a capture and by --from, and one args field holds one value))
          end
          return Scaffold.refusal("Refusing to scaffold: --from #{text} is given twice") if links.include?([step, key])

          links << [step, key]
        end
        links
      end

      # The type a step, by class name, declares for a returns key.
      #: () -> ^(String, String) -> untyped
      def type_of
        lambda do |klass, key|
          step = Check.new(@steps, []).usable.find { _1.name == klass }
          step&.returns&.[](key)&.type
        end
      end

      # Each `--from` resolved against the project's steps, grouped by key,
      # or the first producer that cannot give its key.
      #: (Array[[String, String]]) -> (Array[Chained] | Refusal)
      def chain(links)
        usable = Check.new(@steps, []).usable
        broken = @steps.size - usable.size
        by_key = {} #: Hash[String, Chained]
        links.each do |step_name, key|
          producer = usable.find { _1.step_name == step_name }
          unless producer
            unread = broken.zero? ? "" : "; #{broken} step file(s) did not import, and `nuka check` names them"
            return Scaffold.refusal(%(Refusing to scaffold: no typed step is named "#{step_name}" (`nuka steps` lists the vocabulary)#{unread}), "step-inputs-invalid")
          end
          file = Pathname.new(producer.file).relative_path_from(Pathname.new(File.expand_path(@project))).to_s
          return_it = "return #{key} from its run()"
          again = { run: ["nuka", "scaffold", *@argv_words].join(" ") }
          returns = producer.returns
          unless returns
            return Scaffold.refusal(%(Refusing to scaffold: #{step_name} declares no returns, so it has no key to chain; declare returns with "#{key}" in #{file}),
                                    "step-inputs-invalid", fix: "Add a returns block with #{key} to #{file} and #{return_it}.", **again)
          end
          field = returns[key]
          unless field
            named = returns.fields.empty? ? "it returns no keys" : "its keys are #{returns.fields.map(&:name).join(", ")}"
            return Scaffold.refusal(%(Refusing to scaffold: #{step_name} does not return "#{key}"; #{named}), "step-inputs-invalid",
                                    fix: %(Add "#{key}" to returns in #{file} and #{return_it}.), **again)
          end
          earlier = by_key[key]
          unless earlier
            by_key[key] = Chained.new(key, [producer.name.to_s], field.type)
            next
          end
          first = Schema.json_type(earlier.type)
          this = Schema.json_type(field.type)
          if first != this
            earlier_name = usable.find { _1.name == earlier.producers.first }&.step_name
            return Scaffold.refusal("Refusing to scaffold: --from #{earlier_name}.#{key} and --from #{step_name}.#{key} fill one args field, which holds one type, " +
                                    %(and their schemas differ (#{JSON.generate(first)} and #{JSON.generate(this)}); give both producers the same schema for "#{key}", or chain them into different keys))
          end
          by_key[key] = earlier.with(producers: [*earlier.producers, producer.name.to_s])
        end
        by_key.values
      end

      # Why `--argv <key>` cannot split that key, or nil when it is a string
      # capture that stays in argv.
      #: (String, bool, String?, Array[Capture]) -> Refusal?
      def argv_refusal(key, command, cwd, captures)
        unless command
          return Scaffold.refusal("Refusing to scaffold: --argv names the capture a --command step splits into argv, and only a --command step runs a program", "invalid-arguments")
        end
        if key == cwd
          return Scaffold.refusal("Refusing to scaffold: --argv #{key} and --cwd #{key} name one key, and --cwd takes its key out of argv", "invalid-arguments")
        end

        captured = captures.find { _1.key == key }
        return nil if captured && CAPTURED[captured.type] == :string

        strings = captures.select { CAPTURED[_1.type] == :string }.map(&:key)
        why = captured ? "--argv #{key} names a {#{key}:#{captured.type}} capture, which does not hand the step a string" : "--argv #{key} names no capture of the pattern"
        if strings.empty?
          return Scaffold.refusal("Refusing to scaffold: #{why}, and the pattern captures no string", "invalid-arguments",
                                  fix: "Put an {args:string} capture where the arguments go in --pattern, and pass --argv args.")
        end

        words = @argv_words.each_with_index.map do |word, index|
          next "--argv=#{strings.first}" if word.start_with?("--argv=")

          @argv_words[index - 1] == "--argv" && index.positive? ? strings.first.to_s : word
        end
        Scaffold.refusal("Refusing to scaffold: #{why}; its string captures are #{strings.join(", ")}", "invalid-arguments", run: ["nuka", "scaffold", *words].join(" "))
      end

      public

      # --- --feature ---

      #: (String) -> ([Array[String], Array[String]] | Refusal)
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
          # Every pattern here was read from a line or escaped from one, so
          # a refusal is a fault of this command, not of the feature file.
          raise captures if captures.is_a?(Refusal)

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
      #: (String) -> Hash[Symbol, untyped]
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
      #: (String, untyped) -> Array[untyped]
      def self.generate(text, registry)
        Cucumber::CucumberExpressions::CucumberExpressionGenerator.new(registry).generate_expressions(text.gsub("\\", "\\\\\\\\"))
      end

      # The line as a pattern that matches it and nothing else.
      #: (String) -> String
      def self.literal_pattern(text) = text.gsub("\\", "\\\\\\\\").gsub(/([({\/])/) { "\\#{Regexp.last_match(1)}" }

      #: (String) -> String
      def self.name_captures(source)
        index = 0
        source.gsub(/\\.|\{([^}]*)\}/) do |match|
          next match if match.start_with?("\\")

          key = index.zero? ? "value" : "value#{index + 1}"
          index += 1
          "{#{key}:#{Regexp.last_match(1)}}"
        end
      end

      #: (String) -> String
      def self.name_for(pattern)
        literal = pattern.gsub(/\\(.)|\{[^}]*\}/) { Regexp.last_match(1) || " " }
        words = literal.downcase.gsub(/[^a-z0-9]+/, "-").gsub(/\A-+|-+\z/, "")
        return "step" if words.empty?
        return words if words.size <= NAME_LIMIT

        cut = words[0, NAME_LIMIT + 1].to_s
        dash = cut.rindex("-")
        (dash&.positive? ? cut[0, dash] : cut[0, NAME_LIMIT]).to_s.sub(/-+\z/, "")
      end

      private

      #: (String) { (String) -> boolish } -> String
      def distinct(base)
        return base unless yield(base)

        suffix = 2
        suffix += 1 while yield("#{base}-#{suffix}")
        "#{base}-#{suffix}"
      end

      #: (PickleStep) -> String?
      def attachment_of(line) = line.doc_string ? "docstring" : (line.table ? "table" : nil)

      # What every feature line the pattern matches carries, or nil when no
      # line matches or the lines disagree.
      #: (String) -> String?
      def attachment_in_features(pattern)
        expression = Pattern.new(pattern)
        kinds = @scenarios.flat_map(&:steps).select { expression.match(_1.text) }.map { attachment_of(_1) }.uniq
        kinds.size == 1 ? kinds.first : nil
      rescue StandardError
        nil
      end

      #: (String) -> (Array[String] | Refusal)
      def target_paths(target)
        absolute = File.join(@project, target)
        return Dir.glob("**/*.feature", base: absolute).sort.map { File.join(target, _1) } if File.directory?(absolute)
        return [target] if File.file?(absolute)

        Scaffold.refusal("nuka scaffold --feature: feature file not found: #{target}", "target-not-found")
      end

      #: (String, String) -> void
      def write(relative, source)
        path = File.join(@project, relative)
        FileUtils.mkdir_p(File.dirname(path))
        File.write(path, source)
      end
    end
  end
end
