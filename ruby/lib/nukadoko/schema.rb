# frozen_string_literal: true

# One declaration of a step's args or returns gives three things: the JSON
# Schema the TypeScript engine turns into zod, the RBS a Steep user checks the
# step body against, and the Data class the body receives.
module Nukadoko
  class Schema
    Field = Data.define(:name, :type, :description, :items)

    def self.build(&block)
      schema = new
      schema.instance_eval(&block)
      schema
    end

    attr_reader :fields

    def initialize
      @fields = []
    end

    def string(name, description = nil) = add(name, :string, description)
    def boolean(name, description = nil) = add(name, :boolean, description)
    def integer(name, description = nil) = add(name, :integer, description)
    def number(name, description = nil) = add(name, :number, description)
    def strings(name, description = nil) = add(name, :array, description, :string)
    def table(name, description = nil) = add(name, :array, description, :strings)

    def json_schema
      {
        type: "object",
        properties: fields.to_h { [_1.name.to_s, field_schema(_1)] },
        required: fields.map { _1.name.to_s },
        additionalProperties: false
      }
    end

    def data_class
      @data_class ||= fields.empty? ? Data.define : Data.define(*fields.map(&:name))
    end

    def load(hash)
      data_class.new(**fields.to_h { [_1.name, hash.fetch(_1.name.to_s)] })
    end

    def rbs_fields
      fields.map { "attr_reader #{_1.name}: #{rbs_type(_1)}" }
    end

    def rbs_record
      "{ " + fields.map { "#{_1.name}: #{rbs_type(_1)}" }.join(", ") + " }"
    end

    private

    def add(name, type, description, items = nil)
      fields << Field.new(name, type, description, items)
    end

    def field_schema(field)
      base =
        case [field.type, field.items]
        in [:array, :string] then { type: "array", items: { type: "string" } }
        in [:array, :strings] then { type: "array", items: { type: "array", items: { type: "string" } } }
        else { type: field.type.to_s }
        end
      field.description ? base.merge(description: field.description) : base
    end

    def rbs_type(field)
      case [field.type, field.items]
      in [:array, :string] then "Array[String]"
      in [:array, :strings] then "Array[Array[String]]"
      in [:string, _] then "String"
      in [:boolean, _] then "bool"
      in [:integer, _] then "Integer"
      in [:number, _] then "Float"
      end
    end
  end
end

module Nukadoko
  class Schema
    def without(names)
      copy = Schema.new
      fields.each { copy.fields << _1 unless names.include?(_1.name.to_s) }
      copy
    end
  end
end
