# frozen_string_literal: true

require "cucumber/cucumber_expressions/cucumber_expression"
require "cucumber/cucumber_expressions/parameter_type_registry"

# A pattern names every capture (`{title:string}`). The names are stripped and
# the plain expression goes to the official cucumber-expressions gem, so the
# syntax owner is the same one the TypeScript engine uses.
module Nukadoko
  module Engine
    class Pattern
      NAMED = /\{([A-Za-z_][\w-]*):([\w-]+)\}/
      REGISTRY = Cucumber::CucumberExpressions::ParameterTypeRegistry.new

      attr_reader :source, :keys

      def initialize(source)
        @source = source
        @keys = source.scan(NAMED).map(&:first)
        @expression = Cucumber::CucumberExpressions::CucumberExpression.new(source.gsub(NAMED, '{\2}'), REGISTRY)
      end

      def match(text)
        found = @expression.match(text)
        found && keys.zip(found.map { _1.value(nil) }).to_h
      end

      # Each capture's text as the line wrote it, quotes included.
      def texts(text)
        found = @expression.match(text)
        found && keys.zip(found.map { _1.group.value }).to_h
      end
    end
  end
end
