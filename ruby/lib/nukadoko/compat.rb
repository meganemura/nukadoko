# frozen_string_literal: true
# rbs_inline: enabled

require "cucumber/cucumber_expressions/cucumber_expression"
require "cucumber/cucumber_expressions/regular_expression"

# The door a cucumber-ruby suite comes in through: its step definitions and
# support files load as they are, with `Given`, `When`, `Then`, `Before`,
# `After`, `World`, and `ParameterType` at the top level, as cucumber-ruby
# defines them, and each line they bind runs with a measured step record.
# A compat step has no contract: its arguments are the captures in order,
# then a table or a docstring, and it is named by its pattern
# (`compat: <pattern>`). It covers the subset suites use most; anything
# else fails when the file loads or when the step runs, never by doing
# something other than what cucumber-ruby did.
module Nukadoko
  module Compat
    # What the door refuses, named so a migrating suite sees why.
    class Unsupported < StandardError; end

    # `pending` in a step: cucumber-ruby's Cucumber::Pending. nukadoko has
    # no pending outcome, so the step fails and says so.
    class Pending < StandardError; end

    # A step definition as the glue registered it.
    Registration = Data.define(:keyword, :pattern, :block, :file, :line)

    class Registration
      # The pattern's text, as `nuka steps` and the step's name show it.
      #: () -> String
      def source = pattern.is_a?(Regexp) ? pattern.inspect : pattern.to_s
    end

    # A Before, After, AfterStep, BeforeAll, or AfterAll hook.
    Hook = Data.define(:type, :tags, :name, :block, :file, :line)

    HOOK_TYPES = %i[before after after_step before_all after_all].freeze
    STEP_OPTIONS = %i[].freeze
    PARAMETER_TYPE_KEYS = %i[name regexp type transformer use_for_snippets prefer_for_regexp_match].freeze

    class << self
      #: () -> Array[Registration]
      def steps = (@steps ||= [])
      #: () -> Array[Hook]
      def hooks = (@hooks ||= [])
      #: () -> Array[Module]
      def world_modules = (@world_modules ||= [])
      #: () -> Proc?
      def world_factory = @world_factory

      #: (Proc?) -> Proc?
      def world_factory=(value)
        @world_factory = value
      end
      #: () -> Array[Hash[Symbol, untyped]]
      def parameter_types = (@parameter_types ||= [])
      # Each glue file that raised while it loaded, with the first line of
      # what it raised.
      #: () -> Array[[String, String]]
      def load_failures = (@load_failures ||= [])

      #: () -> void
      def reset
        @steps = @hooks = @world_modules = @parameter_types = @load_failures = nil
        @world_factory = nil
      end

      #: (Symbol) -> Array[Hook]
      def hooks_of(type) = hooks.select { _1.type == type }

      # A new World for one scenario: the factory's object, or a plain one,
      # with every `World` module in and the door's own methods on it.
      #: () -> untyped
      def new_world
        factory = world_factory
        world = factory ? factory.call : Object.new
        world.extend(WorldMethods)
        world_modules.each { world.extend(_1) }
        world
      end
    end

    # A hook's tag expression in the one shape the door reads: `@tag` or
    # `not @tag`. Anything wider would match differently than cucumber-ruby
    # if read loosely, so it is refused.
    TAG = /\A(?:not\s+)?@[^\s()]+\z/

    #: (String) -> bool
    def self.tag_expression?(text) = TAG.match?(text.strip)

    # Whether a hook applies to a scenario with `tags`: every one of its
    # expressions holds, as cucumber-ruby ands several of them.
    #: (Hook, Array[String]) -> bool
    def self.applies?(hook, tags)
      hook.tags.all? do |expression|
        raise Unsupported, unsupported_tags(expression) unless tag_expression?(expression)

        negated, tag = expression.strip.split(/\s+/, 2).then { _2 ? [true, _2] : [false, _1] }
        tags.include?(tag) != negated
      end
    end

    #: (String) -> String
    def self.unsupported_tags(expression)
      %(Unsupported hook tag expression "#{expression}": the compat door supports only a single "@tag" or its negation "not @tag", ) +
        "not Cucumber's full tag expression grammar (and/or/parentheses); a hook may name several, each of which must hold"
    end

    # The methods cucumber-ruby's glue calls at the top level of a file.
    module Dsl
      %i[Given When Then And But].each do |keyword|
        define_method(keyword) do |pattern, options = {}, &block|
          Compat.register_step(keyword, pattern, options, block)
        end
      end

      #: (*String, ?name: String?) { (untyped) -> void } -> void
      def Before(*tags, name: nil, &block) = Compat.register_hook(:before, tags, name, block)
      #: (*String, ?name: String?) { (untyped) -> void } -> void
      def After(*tags, name: nil, &block) = Compat.register_hook(:after, tags, name, block)
      #: (*String, ?name: String?) { (untyped, untyped) -> void } -> void
      def AfterStep(*tags, name: nil, &block) = Compat.register_hook(:after_step, tags, name, block)
      #: (?name: String?) { () -> void } -> void
      def BeforeAll(name: nil, &block) = Compat.register_hook(:before_all, [], name, block)
      #: (?name: String?) { () -> void } -> void
      def AfterAll(name: nil, &block) = Compat.register_hook(:after_all, [], name, block)

      #: (*untyped) -> void
      def Around(*)
        raise Unsupported, "Around hooks are not part of nukadoko's compat door: split the hook into a Before and an After"
      end

      #: (*untyped) -> void
      def InstallPlugin(*) = raise(Unsupported, "InstallPlugin is cucumber-ruby's own configuration, which nukadoko does not run")
      #: (*untyped) -> void
      def AfterConfiguration(*) = raise(Unsupported, "AfterConfiguration is cucumber-ruby's own configuration, which nukadoko does not run")

      # `World(Module, ...)` mixes modules into every scenario's World, and
      # `World { MyWorld.new }` makes the World itself, as cucumber-ruby does.
      #: (*Module, **Module) ?{ () -> untyped } -> void
      def World(*modules, **namespaced, &factory)
        unless namespaced.empty?
          raise Unsupported, "World with namespaced modules (World(#{namespaced.keys.first}: ...)) is not part of nukadoko's compat door: " \
                             "mix the module in with World(Module)"
        end
        Compat.world_modules.concat(modules)
        return unless factory
        raise Unsupported, "World was given a block twice: cucumber-ruby takes one World factory" if Compat.world_factory

        Compat.world_factory = factory
      end

      #: (**untyped) -> void
      def ParameterType(**options) = Compat.register_parameter_type(options)
    end

    #: (Symbol, untyped, untyped, Proc?) -> void
    def self.register_step(keyword, pattern, options, block)
      raise ArgumentError, "#{keyword} needs a block, the step's body" unless block
      unless pattern.is_a?(String) || pattern.is_a?(Regexp)
        raise ArgumentError, "#{keyword} takes a String (a cucumber expression) or a Regexp, got #{pattern.class}"
      end

      unknown = (options || {}).keys.map(&:to_sym) - STEP_OPTIONS
      raise Unsupported, "#{keyword} option #{unknown.first.inspect} is not part of nukadoko's compat door" if unknown.any?

      file, line = block.source_location
      steps << Registration.new(keyword: keyword, pattern: pattern, block: block, file: File.expand_path(file.to_s), line: line)
    end

    #: (Symbol, Array[String], String?, Proc?) -> void
    def self.register_hook(type, tags, name, block)
      raise ArgumentError, "a #{type} hook needs a block" unless block

      file, line = block.source_location
      hooks << Hook.new(type: type, tags: tags.flatten.map(&:to_s), name: name, block: block, file: File.expand_path(file.to_s), line: line)
    end

    #: (Hash[Symbol, untyped]) -> void
    def self.register_parameter_type(options)
      unknown = options.keys - PARAMETER_TYPE_KEYS
      raise ArgumentError, "ParameterType does not know #{unknown.first.inspect}" if unknown.any?
      raise ArgumentError, "ParameterType needs name: and regexp:" unless options[:name] && options[:regexp]

      parameter_types << options
    end

    # The door's own methods on every World.
    module WorldMethods
      # cucumber-ruby's `pending`: the step stops here, and nukadoko, which
      # has no pending outcome, fails it.
      #: (?String) -> bot
      def pending(message = "TODO") = raise(Pending, message)

      #: (*untyped) -> bot
      def skip_this_scenario(*)
        raise Unsupported, "skip_this_scenario is not part of nukadoko's compat door: a scenario that should not run is left out with a tag"
      end

      # Runs another step by its text, on this World, as cucumber-ruby's
      # `step` does. The step it runs is part of this step's record.
      #: (String, ?untyped) -> untyped
      def step(text, multiline = nil)
        matched = Compat::Step.compat_steps.filter_map { |step| (found = step.match_line(text)) && [step, found] }
        raise Unsupported, %(step "#{text}" matches no compat step) if matched.empty?
        raise Unsupported, %(step "#{text}" matches more than one compat step: #{matched.map { _1.first.step_name }.join(", ")}) if matched.size > 1

        step, found = matched.first
        args = step.values(found, self)
        args << (multiline.is_a?(Array) ? DataTable.new(multiline) : multiline) unless multiline.nil?
        instance_exec(*args, &step.registration.block)
      end

      #: (*untyped) -> bot
      def steps(*)
        raise Unsupported, "steps with Gherkin text is not part of nukadoko's compat door: call step once per line, or write the lines in the scenario"
      end

      # What cucumber-ruby's `log` and `attach` keep: each goes into the
      # step record's `attachments`, as a typed step's `evidence` does.
      #: (*untyped) -> void
      def log(*messages) = Compat.evidence&.call(:log, messages.map(&:to_s))

      #: (untyped, ?String?, ?String?) -> void
      def attach(data, media_type = nil, filename = nil) = Compat.evidence&.call(:attach, [data, media_type, filename])

      # The page nukadoko measures: its trace, screenshots, and requests are
      # the step's. Capybara's `page`, when the glue uses Capybara, is its
      # own and is not measured.
      #: () -> untyped
      def open_page = Compat.open(:page)

      # The `request` fixture: requests to the world, measured.
      #: () -> untyped
      def open_request = Compat.open(:request)
    end

    class << self
      # What the running step opens on demand, set by the run around each
      # compat step; nil outside one.
      #: () -> (^(Symbol) -> untyped)?
      def opener = @opener

      #: ((^(Symbol) -> untyped)?) -> (^(Symbol) -> untyped)?
      def opener=(value)
        @opener = value
      end

      #: () -> (^(Symbol, Array[untyped]) -> void)?
      def evidence = @evidence

      #: ((^(Symbol, Array[untyped]) -> void)?) -> (^(Symbol, Array[untyped]) -> void)?
      def evidence=(value)
        @evidence = value
      end
    end

    #: (Symbol) -> untyped
    def self.open(kind)
      open = opener
      raise Unsupported, "open_#{kind} works inside a step: a hook has no step record for the #{kind} to belong to" unless open

      open.call(kind)
    end

    # cucumber-ruby's DataTable, for the calls glue makes most. A table is
    # read, never changed, and `diff!` is refused rather than half done.
    class DataTable
      #: (Array[Array[String]]) -> void
      def initialize(raw)
        @raw = raw.map { |row| row.map(&:to_s).freeze }.freeze
      end

      #: () -> Array[Array[String]]
      attr_reader :raw

      #: () -> Array[Array[String]]
      def rows = raw.drop(1)

      #: () -> Array[Hash[String, String]]
      def hashes
        header, *body = raw
        body.map { header.zip(_1).to_h }
      end

      #: () -> Array[Hash[Symbol, String]]
      def symbolic_hashes = hashes.map { |row| row.transform_keys { _1.downcase.gsub(/\W+/, "_").to_sym } }

      #: () -> Hash[String, String]
      def rows_hash
        raise ArgumentError, "rows_hash needs a table of two columns, this one has #{raw.first&.size.to_i}" unless raw.all? { _1.size == 2 }

        raw.to_h { [_1[0], _1[1]] }
      end

      #: () -> DataTable
      def transpose = DataTable.new(raw.empty? ? [] : raw.first.zip(*raw.drop(1)).map { _1.map(&:to_s) })

      #: () -> Array[Array[String]]
      def cells_rows = raw

      #: () -> Integer
      def size = raw.size

      #: (untyped) -> bool
      def ==(other) = other.is_a?(DataTable) && other.raw == raw

      #: () -> String
      def to_s = raw.map { |row| "| #{row.join(" | ")} |" }.join("\n")

      #: (*untyped) -> bot
      def diff!(*)
        raise Unsupported, "DataTable#diff! is not part of nukadoko's compat door: compare table.hashes with the rows you expect"
      end

      #: (*untyped) -> bot
      def map_headers!(*) = raise(Unsupported, "DataTable#map_headers! is not part of nukadoko's compat door: read table.hashes and rename the keys")
      #: (*untyped) -> bot
      def map_column!(*) = raise(Unsupported, "DataTable#map_column! is not part of nukadoko's compat door: map the values read from table.hashes")
    end

    # The scenario a Before or After hook is given, as cucumber-ruby gives it.
    class Scenario
      #: (String, Array[String], String?, ?status: Symbol) -> void
      def initialize(name, tags, location, status: :passed)
        @name = name
        @source_tag_names = tags
        @location = location
        @status = status
      end

      attr_reader :name, :source_tag_names, :location
      attr_accessor :status

      #: () -> bool
      def failed? = status == :failed
      #: () -> bool
      def passed? = status == :passed
    end

    # A step's result as AfterStep is given it.
    StepResult = Data.define(:status, :exception)

    class StepResult
      #: () -> bool
      def passed? = status == :passed
      #: () -> bool
      def failed? = status == :failed
    end

    # Each registration as a member of the step vocabulary: a Step
    # subclass named by its pattern, matched with cucumber-expressions or
    # its Regexp, with no contract to check.
    module Step
      #: () -> Array[untyped]
      def self.compat_steps = Nukadoko::Step.registry.select { Vocabulary.compat?(_1) }

      # One Step subclass for a registration.
      #: (Registration) -> singleton(Nukadoko::Step)
      def self.build(registration)
        klass = Class.new(Nukadoko::Step) #: untyped
        klass.extend(Methods)
        klass.instance_variable_set(:@registration, registration)
        klass.instance_variable_set(:@file, registration.file)
        klass
      end

      # What a compat step answers where a typed step reads its declarations.
      module Methods
        #: () -> Registration
        def registration = @registration
        #: () -> bool
        def compat? = true
        #: () -> String
        def step_name = "compat: #{registration.source}"
        #: () -> Integer?
        def line = registration.line
        #: () -> String
        def name = step_name
        # No typed pattern: every check of named captures and args passes
        # a compat step by, and `compat_patterns` is what it lists.
        #: (*untyped) -> Array[String]
        def patterns(*) = []
        #: () -> Array[String]
        def compat_patterns = [registration.source]
        #: () -> bool
        def mutating? = true
        #: () -> Symbol
        def body = :run
        #: () -> Array[Symbol]
        def fixtures = []
        #: (?Array[untyped]) -> Array[Symbol]
        def bag(_seen = []) = []

        # The expression the pattern is read with, against the registry
        # typed patterns read, so a parameter type is one mechanism.
        #: () -> untyped
        def expression
          ce = Cucumber::CucumberExpressions
          @expression ||= if registration.pattern.is_a?(Regexp)
                            ce::RegularExpression.new(registration.pattern, Engine::Pattern.registry)
                          else
                            ce::CucumberExpression.new(registration.pattern, Engine::Pattern.registry)
                          end
        end

        # The arguments a line's text matches, or nil.
        #: (String) -> Array[untyped]?
        def match_line(text)
          return nil if Engine::Pattern.collision

          expression.match(text)
        rescue StandardError
          nil
        end

        # Each capture's value, a parameter type's transformer running on
        # the World, as cucumber-ruby runs it.
        #: (Array[untyped], untyped) -> Array[untyped]
        def values(found, world) = found.map { _1.value(world) }
      end
    end

    # Registers the World methods at the top level and loads `files`, in
    # cucumber-ruby's order: env.rb first, then the rest of support/, then
    # every other file. A file that raises is kept as a load failure and
    # the rest still load, so one broken file does not hide the others.
    #: (Array[String]) -> void
    def self.load(files)
      TOPLEVEL_BINDING.receiver.extend(Dsl)
      files.each do |file|
        before = steps.size
        begin
          require file
        rescue ScriptError, StandardError => e
          load_failures << [file, e.message.lines.first.to_s.chomp]
          steps.slice!(before..)
        end
      end
      steps.drop(@built.to_i).each { Step.build(_1) }
      parameter_types.drop(@registered.to_i).each { |type| register_type(type) }
      @built = steps.size
      @registered = parameter_types.size
    end

    #: (Hash[Symbol, untyped]) -> void
    def self.register_type(type)
      regexps = Array(type[:regexp])
      transformer = type[:transformer] || ->(*groups) { groups.first }
      Engine::Pattern.registry.define_parameter_type(
        Cucumber::CucumberExpressions::ParameterType.new(type[:name].to_s, regexps, type[:type] || Object, transformer,
                                                         type.fetch(:use_for_snippets, true), type.fetch(:prefer_for_regexp_match, false))
      )
    rescue StandardError => e
      load_failures << [File.expand_path(transformer.source_location&.first.to_s), e.message.lines.first.to_s.chomp]
    end

    # The glue files under `features`, in the order cucumber-ruby loads
    # them; the typed step files under `steps_dir` are among them.
    #: (String, String) -> Array[String]
    def self.files(features, steps_dir)
      all = Dir.glob(File.join(features, "**/*.rb")).sort.map { File.expand_path(_1) }
      support = File.expand_path(File.join(features, "support"))
      env = File.join(support, "env.rb")
      in_support = all.select { _1.start_with?("#{support}/") }
      [*([env] & all), *(in_support - [env]), *(all - in_support - [env])]
    end
  end
end
