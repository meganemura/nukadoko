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

      def inherited(subclass)
        super
        subclass.instance_variable_set(:@file, caller_locations(1, 1)&.first&.absolute_path)
        Step.registry << subclass
      end

      def registry = (@registry ||= [])

      #: (String) -> String
      #: () -> String?
      def pattern(text = nil) = text ? (@pattern = text) : @pattern
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
      def inputs = claims ? args.without(expected_keys(claims)) : args

      def step_name = File.basename(file, ".rb").tr("_", "-")

      # A step that runs code may change the world unless it says it does
      # not; a claim step has no action, so it never does.
      def mutating? = claims ? false : mutates != false
      def body = claims ? :observe : :run
      def line = method_defined?(body) ? instance_method(body).source_location&.last : nil

      def fixtures
        return [] unless method_defined?(body)

        instance_method(body).parameters.filter_map { |kind, name| name if kind == :keyreq && name != :args }
      end

      # The fixtures the engine builds before the body runs: the step's own,
      # and those of every part it can reach, since the bag is closed before
      # any call happens.
      def bag(seen = [])
        return [] if seen.include?(self)

        reachable = parts.select { _1.is_a?(Class) && _1 < Step }.flat_map { _1.bag([*seen, self]) }
        (fixtures + reachable - (seen.empty? ? [] : [:call])).uniq
      end

      private

      def expected_keys(node)
        case node
        in Array then node.flat_map { expected_keys(_1) }
        in Hash then node.flat_map { |k, v| k.to_s == "expected" ? expected_key(v) : expected_keys(v) }
        else []
        end
      end

      def expected_key(value)
        case value
        in String then [value]
        in { from: String => key } then [key]
        else []
        end
      end
    end
  end

  # Each step file is registered for autoload under its class name first, so a
  # step can name another in `from` or `field` whatever order the files load in.
  def self.load_steps(dir)
    files = Dir.glob(File.join(dir, "**/*.rb")).sort.map { File.expand_path(_1) }
    files.each { Object.autoload(File.basename(_1, ".rb").split("_").map(&:capitalize).join.to_sym, _1) }
    files.each { require _1 }
    Step.registry
  end
end
