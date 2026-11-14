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

    # `null: true` lets the value be nil as well, as zod's `.nullable()` does.
    def string(name, description = nil, null: false) = add(name, :string, description, null)
    def boolean(name, description = nil, null: false) = add(name, :boolean, description, null)
    def integer(name, description = nil, null: false) = add(name, :integer, description, null)
    def number(name, description = nil, null: false) = add(name, :number, description, null)
    def unknown(name, description = nil) = add(name, :unknown, description)
    def enum(name, values, description = nil, null: false) = add(name, [:enum, values.map(&:to_s)], description, null)
    def strings(name, description = nil, null: false) = add(name, [:array, :string], description, null)
    def table(name, description = nil, null: false) = add(name, [:array, [:array, :string]], description, null)
    def object(name, description = nil, null: false, &block) = add(name, Schema.build(&block), description, null)

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
    # A key the schema does not declare is no problem: as a zod object does,
    # the schema drops it (`strip`), and `dropped` names where.
    def problems(value, path = nil)
      return ["#{path || "value"} must be an object, got #{value.inspect}"] unless value.is_a?(Hash)

      hash = value.transform_keys(&:to_s)
      fields.flat_map do |field|
        key = join(path, field.name)
        hash.key?(field.name.to_s) ? Schema.type_problems(field.type, hash[field.name.to_s], key) : ["#{key} is missing"]
      end
    end

    # The value with every key the schema does not declare left out, at any
    # depth, with string keys. Assumes `problems` found none.
    def strip(value)
      hash = value.transform_keys(&:to_s)
      fields.to_h { [_1.name.to_s, Schema.strip_type(_1.type, hash[_1.name.to_s])] }
    end

    def self.strip_type(type, value)
      case type
      in [:nullable, inner] then value.nil? ? nil : strip_type(inner, value)
      in [:array, item] then value.map { strip_type(item, _1) }
      in Schema then type.strip(value)
      else value
      end
    end

    # The paths of the keys `strip` leaves out, so a record can say what the
    # step returned and the contract did not keep.
    def dropped(value, path = nil)
      hash = value.transform_keys(&:to_s)
      names = fields.map { _1.name.to_s }
      (hash.keys - names).map { join(path, _1) } + fields.flat_map { Schema.dropped_type(_1.type, hash[_1.name.to_s], join(path, _1.name)) }
    end

    def self.dropped_type(type, value, path)
      case type
      in [:nullable, inner] then value.nil? ? [] : dropped_type(inner, value, path)
      in [:array, item] then value.each_with_index.flat_map { dropped_type(item, _1, "#{path}[#{_2}]") }
      in Schema then type.dropped(value, path)
      else []
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
        in [:nullable, inner] then return value.nil? ? [] : type_problems(inner, value, path)
        in [:enum, values] then values.include?(value.is_a?(Symbol) ? value.to_s : value)
        in [:array, item]
          return ["#{path} must be an array, got #{value.inspect}"] unless value.is_a?(Array)

          return value.each_with_index.flat_map { |v, i| type_problems(item, v, "#{path}[#{i}]") }
        in Schema then return type.problems(value, path)
        end
      ok ? [] : ["#{path} must be #{type}, got #{value.inspect}"]
    end

    # The JSON Schema `nuka describe` prints, as zod's own conversion gives it:
    # the root is closed, and an inner object is closed only on the output
    # side (`returns`), where zod drops the keys it does not declare.
    def json_schema(root: true, output: false)
      schema = { type: "object", properties: fields.to_h { [_1.name, Schema.json_type(_1.type, output).merge(_1.description ? { description: _1.description } : {})] } }
      schema[:required] = fields.map(&:name) if fields.any?
      return { "$schema": "https://json-schema.org/draft/2020-12/schema", **schema, additionalProperties: false } if root

      output ? schema.merge(additionalProperties: false) : schema
    end

    def self.json_type(type, output = false)
      case type
      in :string then { type: "string" }
      in :boolean then { type: "boolean" }
      in :integer then { type: "integer" }
      in :number then { type: "number" }
      in :unknown then {}
      in [:nullable, inner] then { anyOf: [json_type(inner, output), { type: "null" }] }
      in [:enum, values] then { type: "string", enum: values }
      in [:array, item] then { type: "array", items: json_type(item, output) }
      in Schema then type.json_schema(root: false, output: output)
      end
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
      in [:nullable, inner] then "(#{rbs_type(inner)})?"
      in [:enum, values] then values.map(&:inspect).join(" | ")
      in [:array, item] then "Array[#{rbs_type(item)}]"
      in Schema then type.fields.empty? ? "Hash[Symbol, untyped]" : type.rbs_record
      end
    end

    private

    def add(name, type, description, null = false) = fields << Field.new(name.to_sym, null ? [:nullable, type] : type, description)
    def join(path, name) = path ? "#{path}.#{name}" : name.to_s
  end
end
