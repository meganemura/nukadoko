# frozen_string_literal: true
# rbs_inline: enabled

# A step is a class under features/steps/, one per file, named by its file.
# Everything except the body is a class-level declaration, so check reads the
# contract without calling the body, and `Method#parameters` names the
# fixtures the body asks for.
module Nukadoko
  class Step
    class << self
      #: () -> String
      def file = @file

      #: (singleton(Step)) -> void
      def inherited(subclass)
        super
        subclass.instance_variable_set(:@file, caller_locations(1, 1)&.first&.absolute_path)
        Step.registry << subclass
      end

      #: () -> Array[singleton(Step)]
      def registry = (@registry ||= [])

      #: (String) -> String
      #: () -> String?
      def pattern(text = nil) = text ? (@pattern = text) : @pattern

      # Every wording a line may bind the step by: `pattern` first, then
      # each of `patterns`, as the TypeScript engine reads both. Each one
      # must capture the same keys, which nuka check holds them to.
      #: (*String | Array[String]) -> Array[String]
      def patterns(*texts)
        return [*@pattern, *@patterns] if texts.empty?

        @patterns = texts.flatten.freeze
      end

      #: (String) -> String
      #: () -> String?
      def description(text = nil) = text ? (@description = text) : @description
      #: (bool) -> bool
      #: () -> bool?
      def mutates(value = nil) = value.nil? ? @mutates : (@mutates = value)
      #: (Array[Hash[Symbol, untyped]]) -> Array[Hash[Symbol, untyped]]
      #: () -> Array[Hash[Symbol, untyped]]?
      def claims(list = nil) = list ? (@claims = list) : @claims
      #: (untyped) -> untyped
      #: () -> untyped
      def poll(value = nil) = value.nil? ? @poll : (@poll = value)

      # How long `run` (or `observe`) may take, in milliseconds, before the
      # step fails as timed out. Without it the config's stepTimeout
      # applies, twenty minutes by default; there is no value for no
      # limit, since a step that never returns would take the run with it.
      #: (untyped) -> untyped
      #: () -> untyped
      def timeout(ms = nil) = ms.nil? ? @timeout : (@timeout = ms)

      # The paths an earlier step's commands changed, by the key a claim
      # reads them as: `files written: { of: RunBuild, change: "added",
      # under: "src/" }`. nukadoko reads the list from that step's record,
      # never from what its code returned.
      #: (Hash[Symbol | String, untyped]) -> Hash[String, untyped]
      #: () -> Hash[String, untyped]
      def files(map = nil)
        return @files || {} unless map

        @files = map.is_a?(Hash) ? map.transform_keys(&:to_s) : map
      end

      # The states a line of this step needs held (`requires`), leaves
      # held (`gives`), and leaves not held (`ends`), each a name
      # ("book-open") or a name and the args key that tells one holder from
      # another (["signed-in", :person]). nuka check walks them through each
      # scenario, and nuka run refuses a scenario that can only reach a line
      # without the state it requires.
      #: (*untyped) -> Array[untyped]
      def requires(*entries) = entries.empty? ? (@requires || []) : (@requires = entries.freeze)
      #: (*untyped) -> Array[untyped]
      def gives(*entries) = entries.empty? ? (@gives || []) : (@gives = entries.freeze)
      #: (*untyped) -> Array[untyped]
      def ends(*entries) = entries.empty? ? (@ends || []) : (@ends = entries.freeze)

      # The three lists read, or nil while one of them is malformed, which
      # Definition reports.
      #: () -> Engine::States::Declared?
      def states
        read = Engine::States.read(self)
        read.is_a?(Engine::States::Declared) ? read : nil
      end

      # The steps this one may run through the `call` fixture. A part with no
      # pattern exists only for calls.
      #: (Array[singleton(Step)]) -> Array[singleton(Step)]
      #: () -> Array[singleton(Step)]
      def parts(list = nil) = list ? (@parts = list.freeze) : (@parts || [])

      #: () { () [self: Schema] -> void } -> Schema
      #: () -> Schema
      def args(&block) = block ? (@args = Schema.build(&block)) : (@args ||= Schema.new)
      #: () { () [self: Schema] -> void } -> Schema
      #: () -> Schema?
      def returns(&block) = block ? (@returns = Schema.build(&block)) : @returns

      # Args an earlier step of the scenario returned, by key: one source as
      # `[Step, :field]`, or several as a list of them, where the nearest
      # earlier one that ran gives the value.
      #: (Hash[Symbol | String, untyped]) -> Hash[String, Array[untyped]]
      #: () -> Hash[String, Array[untyped]]
      def from(map = nil)
        return @from || {} unless map

        @from = map.to_h { |key, source| [key.to_s, source.first.is_a?(Array) ? source : [source]] }
      end

      # observe never sees the args a claim compares with, so it cannot pick
      # what to read by the answer it will be judged against.
      #: () -> Schema
      def inputs
        claims = self.claims
        claims ? args.without(Engine::ClaimRules.withheld_keys(claims, from.keys).keys) : args
      end

      #: () -> String
      def step_name = File.basename(file, ".rb").tr("_", "-")

      # A step that runs code may change the world unless it says it does
      # not; a claim step has no action, so it never does.
      #: () -> bool
      def mutating? = claims ? false : mutates != false
      #: () -> Symbol
      def body = claims ? :observe : :run
      #: () -> Integer?
      def line = method_defined?(body) ? instance_method(body).source_location&.last : nil

      #: () -> Array[Symbol]
      def fixtures
        return [] unless method_defined?(body)

        instance_method(body).parameters.filter_map { |kind, name| name if kind == :keyreq && name != :args }
      end

      # What `run` gave back, checked against `returns`, as problems to
      # report. A Ruby method always gives back its last value, so a step
      # with no returns that ends on a call (an Integer, a String, nil)
      # returns nothing; a Hash with keys would lose them from the record,
      # so that is refused, as the TypeScript engine refuses it.
      #: (untyped) -> [untyped, Array[String]]
      def returned(value)
        schema = returns
        # nil is a body that gave back nothing, which zod's "(root): expected
        # object" would leave without its cause or either fix.
        if schema
          nothing = "this step declares returns, but run returned nothing; return a value that matches returns, " \
                    "or delete returns if no later step reads from this one"
          return [value, value.nil? ? [nothing] : schema.problems(value)]
        end
        return [{}, []] unless value.is_a?(Hash)
        return [value, []] if value.empty?

        one = value.size == 1
        [value, ["this step declares no returns, so #{value.keys.join(", ")} would be dropped from the step record; declare returns with #{one ? "that key" : "those keys"}, or stop returning #{one ? "it" : "them"}"]]
      end

      # The keywords the body is called with: `args` only when it names
      # them, as a TypeScript step that does not destructure `args` never
      # sees them, so `def run(scratch:)` is a whole step.
      #: (Hash[Symbol, untyped], untyped) -> Hash[Symbol, untyped]
      def keywords(fixtures, args)
        params = method_defined?(body) ? instance_method(body).parameters : []
        takes = params.any? { |kind, name| kind == :keyrest || (name == :args && %i[key keyreq].include?(kind)) }
        takes ? fixtures.merge(args: args) : fixtures
      end

      # The fixtures the engine builds before the body runs: the step's own,
      # and those of every part it can reach, since the bag is closed before
      # any call happens.
      #: (?Array[singleton(Step)]) -> Array[Symbol]
      def bag(seen = [])
        return [] if seen.include?(self)

        reachable = parts.select { _1.is_a?(Class) && _1 < Step }.flat_map { _1.bag([*seen, self]) }
        (fixtures + reachable - (seen.empty? ? [] : [:call])).uniq
      end
    end
  end

  # Each step file is registered for autoload under its class name first, so a
  # step can name another in `from` or `field` whatever order the files load in.
  #: (String) -> Array[singleton(Step)]
  def self.load_steps(dir)
    files = Dir.glob(File.join(dir, "**/*.rb")).sort.map { File.expand_path(_1) }
    files.each { Object.autoload(File.basename(_1, ".rb").split("_").map(&:capitalize).join.to_sym, _1) }
    files.each { require _1 }
    Step.registry
  end
end
