# frozen_string_literal: true

# One declaration of a step's args or returns gives three things: the check
# a value must pass at run time, the RBS a Steep user checks the step body
# against, and the Data class the body receives. A type is a symbol for a
# scalar, `[:array, type]` for a list, or a nested Schema for an object.
module Nukadoko
  class Schema
    Field = Data.define(:name, :type, :description)

    def self.build(&block)
      schema = new
      schema.instance_eval(&block) if block
      schema
    end

    attr_reader :fields

    def initialize(fields = [])
      @fields = fields
    end

    def string(name, description = nil) = add(name, :string, description)
    def boolean(name, description = nil) = add(name, :boolean, description)
    def integer(name, description = nil) = add(name, :integer, description)
    def number(name, description = nil) = add(name, :number, description)
    def unknown(name, description = nil) = add(name, :unknown, description)
    def strings(name, description = nil) = add(name, [:array, :string], description)
    def table(name, description = nil) = add(name, [:array, [:array, :string]], description)
    def object(name, description = nil, &block) = add(name, Schema.build(&block), description)

    # Reuses a field another step declared, so two contracts that must agree
    # on one shape are written once: `field :created, AnItemExists.returns[:body]`.
    def field(name, other, description = nil) = add(name, other.type, description || other.description)

    def [](name) = fields.find { _1.name == name.to_sym }

    def without(names) = Schema.new(fields.reject { names.include?(_1.name.to_s) })

    def data_class
      @data_class ||= fields.empty? ? Data.define : Data.define(*fields.map(&:name))
    end

    def load(hash)
      data_class.new(**fields.to_h { [_1.name, hash.fetch(_1.name.to_s)] })
    end

    # Every way `value` departs from the schema, as `path: problem` lines.
    # Keys the schema does not declare are a problem too, as zod's strict
    # objects make them on the TypeScript side.
    def problems(value, path = nil)
      return ["#{path || "value"} must be an object, got #{value.inspect}"] unless value.is_a?(Hash)

      hash = value.transform_keys(&:to_s)
      extra = (hash.keys - fields.map { _1.name.to_s }).map { "#{join(path, _1)} is not declared" }
      extra + fields.flat_map do |field|
        key = join(path, field.name)
        hash.key?(field.name.to_s) ? Schema.type_problems(field.type, hash[field.name.to_s], key) : ["#{key} is missing"]
      end
    end

    def self.type_problems(type, value, path)
      ok =
        case type
        in :string then value.is_a?(String)
        in :boolean then [true, false].include?(value)
        in :integer then value.is_a?(Integer)
        in :number then value.is_a?(Numeric)
        in :unknown then true
        in [:array, item]
          return ["#{path} must be an array, got #{value.inspect}"] unless value.is_a?(Array)

          return value.each_with_index.flat_map { |v, i| type_problems(item, v, "#{path}[#{i}]") }
        in Schema then return type.problems(value, path)
        end
      ok ? [] : ["#{path} must be #{type}, got #{value.inspect}"]
    end

    def rbs_fields = fields.map { "attr_reader #{_1.name}: #{Schema.rbs_type(_1.type)}" }
    def rbs_record = "{ #{fields.map { "#{_1.name}: #{Schema.rbs_type(_1.type)}" }.join(", ")} }"

    def self.rbs_type(type)
      case type
      in :string then "String"
      in :boolean then "bool"
      in :integer then "Integer"
      in :number then "Numeric"
      in :unknown then "untyped"
      in [:array, item] then "Array[#{rbs_type(item)}]"
      in Schema then type.fields.empty? ? "Hash[Symbol, untyped]" : type.rbs_record
      end
    end

    private

    def add(name, type, description) = fields << Field.new(name.to_sym, type, description)
    def join(path, name) = path ? "#{path}.#{name}" : name.to_s
  end
end
