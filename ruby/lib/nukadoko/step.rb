# frozen_string_literal: true

# A step is a class under features/steps/, one per file, named by its file.
# Everything except the body is a class-level declaration, so check reads the
# contract without calling the body, and `Method#parameters` names the
# fixtures the body asks for.
module Nukadoko
  class Step
    class << self
      attr_reader :file

      def inherited(subclass)
        super
        subclass.instance_variable_set(:@file, caller_locations(1, 1).first.absolute_path)
        Step.registry << subclass
      end

      def registry = (@registry ||= [])

      def pattern(text = nil) = text ? (@pattern = text) : @pattern
      def description(text = nil) = text ? (@description = text) : @description
      def mutates(value = nil) = value.nil? ? @mutates : (@mutates = value)
      def claims(list = nil) = list ? (@claims = list) : @claims
      def poll(value = nil) = value.nil? ? @poll : (@poll = value)

      def args(&block) = block ? (@args = Schema.build(&block)) : (@args ||= Schema.new)
      def returns(&block) = block ? (@returns = Schema.build(&block)) : @returns

      # observe never sees the args a claim compares with, so it cannot pick
      # what to read by the answer it will be judged against.
      def inputs = claims ? args.without(expected_keys(claims)) : args

      def step_name = File.basename(file, ".rb").tr("_", "-")
      def body = claims ? :observe : :run
      def line = method_defined?(body) ? instance_method(body).source_location&.last : nil

      def fixtures
        return [] unless method_defined?(body)

        instance_method(body).parameters.filter_map { |kind, name| name if kind == :keyreq && name != :args }
      end

      private

      def expected_keys(node)
        case node
        in Array then node.flat_map { expected_keys(_1) }
        in Hash then node.flat_map { |k, v| k.to_s == "expected" && v.is_a?(String) ? [v] : expected_keys(v) }
        else []
        end
      end
    end
  end

  def self.load_steps(dir)
    Dir.glob(File.join(dir, "**/*.rb")).sort.each { require File.expand_path(_1) }
    Step.registry
  end
end
