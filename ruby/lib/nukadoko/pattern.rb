# frozen_string_literal: true
# rbs_inline: enabled

require "cucumber/cucumber_expressions/cucumber_expression"
require "cucumber/cucumber_expressions/parameter_type_registry"

# A pattern names every capture (`{title:string}`). The names are stripped and
# the plain expression goes to the official cucumber-expressions gem, so the
# syntax owner is the same one the TypeScript engine uses.
module Nukadoko
  module Engine
    class Pattern
      CE = Cucumber::CucumberExpressions

      # The built-in parameter types as the JavaScript package defines them.
      # The gem's own differ: its \s takes no Unicode space, so {word} read
      # "a<no-break space>b" as one word, and its float takes no "1." prefix
      # or the lookahead JavaScript's does, so a line bound to one step in
      # one engine and to none in the other. A value is what the JavaScript
      # transformer gives: Number for an integer (a double past 2**53),
      # parseFloat for a float, and the matched text for a bigdecimal.
      class Registry < Cucumber::CucumberExpressions::ParameterTypeRegistry
        INTEGER = [/-?\d+/, /\d+/].freeze
        FLOAT = /(?=[^\n\r  ]*\d[^\n\r  ]*)[-+]?\d*(?:\.(?=\d[^\n\r  ]*))?\d*(?:\d+[E][+-]?\d+)?/
        WORD = /[^#{Spaces::CLASS}]+/
        STRING = CE::ParameterTypeRegistry::STRING_REGEXP
        ANONYMOUS = /[^\n\r  ]*/
        DECIMAL = /\A[-+]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/

        # JavaScript's Number of a text of digits.
        #: (String?) -> Numeric?
        def self.number(text)
          return nil if text.nil?

          value = Integer(text, 10)
          value.abs > 2**53 ? value.to_f : value
        end

        # JavaScript's parseFloat: the longest number at the start, or NaN.
        #: (String?) -> Float?
        def self.parse_float(text)
          return nil if text.nil?

          found = text.sub(/\A[#{Spaces::CLASS}]+/, "")[DECIMAL]
          return Float::NAN if found.nil?

          sign = found.start_with?("-") ? -1 : 1
          return sign * Float::INFINITY if found.end_with?("Infinity")

          Float(found.sub(/\.(?=[eE]|\z)/, ""))
        end

        #: () -> void
        def initialize
          @parameter_type_by_name = {}
          @parameter_types_by_regexp = Hash.new { |hash, regexp| hash[regexp] = [] }
          number = ->(s = nil) { Registry.number(s) }
          float = ->(s = nil) { Registry.parse_float(s) }
          define_parameter_type(CE::ParameterType.new("int", INTEGER, Integer, number, true, true))
          define_parameter_type(CE::ParameterType.new("float", FLOAT, Float, float, true, false))
          define_parameter_type(CE::ParameterType.new("word", WORD, String, ->(s = nil) { s }, false, false))
          define_parameter_type(CE::ParameterType.new("string", STRING, String, lambda { |s1, s2|
            (s1 || s2 || "").gsub('\\"', '"').gsub("\\'", "'")
          }, true, false))
          define_parameter_type(CE::ParameterType.new("", ANONYMOUS, String, ->(s = nil) { s }, false, true))
          define_parameter_type(CE::ParameterType.new("double", FLOAT, Float, float, false, false))
          define_parameter_type(CE::ParameterType.new("bigdecimal", FLOAT, String, ->(s = nil) { s }, false, false))
          %w[byte short long].each { define_parameter_type(CE::ParameterType.new(_1, INTEGER, Integer, number, false, false)) }
          define_parameter_type(CE::ParameterType.new("biginteger", INTEGER, Integer, ->(s = nil) { s && Integer(s, 10) }, false, false))
        end
      end

      NAMED = /\{([A-Za-z_][\w-]*):([\w-]+)\}/
      REGISTRY = Registry.new

      attr_reader :source, :keys

      #: (String) -> void
      def initialize(source)
        @source = source
        @keys = source.scan(NAMED).map { Array(_1).first.to_s }
        @expression = CE::CucumberExpression.new(source.gsub(NAMED, '{\2}'), REGISTRY)
      end

      #: (String) -> Hash[String, untyped]?
      def match(text)
        found = @expression.match(text)
        found && keys.zip(found.map { _1.value(nil) }).to_h
      end

      # Each capture's text as the line wrote it, quotes included.
      #: (String) -> Hash[String, String]?
      def texts(text)
        found = @expression.match(text)
        found && keys.zip(found.map { _1.group.value }).to_h
      end
    end
  end
end
