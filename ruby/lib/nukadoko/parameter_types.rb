# frozen_string_literal: true
# rbs_inline: enabled

# The config's parameterTypes, read and handed to Pattern: each entry a
# name, a regexp, and an optional transformer. A shape the TypeScript
# engine's schema refuses is refused here with its words, so a project
# moves between the engines without a config that one of them takes and
# the other does not. Boundary: reading the entries; registering them and
# matching lines are Pattern's.
module Nukadoko
  module Engine
    module ParameterTypes
      NAME = /\A[a-zA-Z0-9_-]+\z/
      KEYS = %i[name regexp transformer].freeze

      #: (untyped) -> void
      def self.read(types)
        types = [] if types.nil?
        invalid("parameterTypes: Invalid input: expected array, received #{kind(types)}") unless types.is_a?(Array)
        types.each_with_index do |type, index|
          at = "parameterTypes.#{index}"
          invalid("#{at}: Invalid input: expected object, received #{kind(type)}") unless type.is_a?(Hash)
          extra = type.keys.map(&:to_sym) - KEYS
          invalid("unknown key(s): #{extra.join(", ")}") if extra.any?
          name = type[:name]
          invalid("#{at}.name: Invalid input: expected string, received #{kind(name)}") unless name.is_a?(String)
          invalid("#{at}.name: Invalid string: must match pattern /^[a-zA-Z0-9_-]+$/") unless name.match?(NAME)
          invalid("#{at}.regexp: must be a Regexp or a string") unless type[:regexp].is_a?(Regexp) || type[:regexp].is_a?(String)
          invalid("#{at}.transformer: must be a function") unless type[:transformer].nil? || type[:transformer].respond_to?(:call)
        end
        Pattern.configure(types)
      end

      # A value's kind in the words zod uses for it.
      #: (untyped) -> String
      def self.kind(value)
        case value
        when nil then "undefined"
        when String then "string"
        when Numeric then "number"
        when true, false then "boolean"
        when Array then "array"
        when Hash then "object"
        else value.class.name.to_s.downcase
        end
      end

      #: (String) -> bot
      def self.invalid(detail)
        raise Refusal.new("config-invalid", "Invalid config at #{CONFIG}: #{detail}", fix: "Correct the fields the message names in #{CONFIG}.")
      end
    end
  end
end
