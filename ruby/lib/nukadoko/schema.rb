# frozen_string_literal: true
# rbs_inline: enabled

# One declaration of a step's args or returns gives three things: the check
# a value must pass at run time, the RBS a Steep user checks the step body
# against, and the Data class the body receives. A type is a symbol for a
# scalar, `[:array, type]` for a list, or a nested Schema for an object.
module Nukadoko
  class Schema
    Field = Data.define(
      :name, #: Symbol
      :type, #: untyped
      :description, #: String?
    )

    #: () ?{ () [self: Schema] -> void } -> Schema
    def self.build(&block)
      schema = new
      schema.instance_exec(&block) if block
      schema
    end

    attr_reader :fields #: Array[Field]

    #: (?Array[Field]) -> void
    def initialize(fields = [])
      @fields = fields
    end

    # `null: true` lets the value be nil as well, as zod's `.nullable()` does.
    #: (Symbol, ?String?, ?null: bool) -> void
    def string(name, description = nil, null: false) = add(name, :string, description, null)
    #: (Symbol, ?String?, ?null: bool) -> void
    def boolean(name, description = nil, null: false) = add(name, :boolean, description, null)
    #: (Symbol, ?String?, ?null: bool) -> void
    def integer(name, description = nil, null: false) = add(name, :integer, description, null)
    #: (Symbol, ?String?, ?null: bool) -> void
    def number(name, description = nil, null: false) = add(name, :number, description, null)
    #: (Symbol, ?String?) -> void
    def unknown(name, description = nil) = add(name, :unknown, description)
    #: (Symbol, Array[String | Symbol], ?String?, ?null: bool) -> void
    def enum(name, values, description = nil, null: false) = add(name, [:enum, values.map(&:to_s)], description, null)
    #: (Symbol, ?String?, ?null: bool) -> void
    def strings(name, description = nil, null: false) = add(name, [:array, :string], description, null)
    #: (Symbol, ?String?, ?null: bool) -> void
    def table(name, description = nil, null: false) = add(name, [:array, [:array, :string]], description, null)
    #: (Symbol, ?String?, ?null: bool) { () [self: Schema] -> void } -> void
    def object(name, description = nil, null: false, &block) = add(name, Schema.build(&block), description, null)

    # Reuses a field another step declared, so two contracts that must agree
    # on one shape are written once: `field :created, AnItemExists.returns[:body]`.
    #: (Symbol, Field, ?String?) -> void
    def field(name, other, description = nil) = add(name, other.type, description || other.description)

    #: (Symbol | String) -> Field?
    def [](name) = fields.find { _1.name == name.to_sym }

    #: (Array[String]) -> Schema
    def without(names) = Schema.new(fields.reject { names.include?(_1.name.to_s) })

    #: () -> untyped
    def data_class
      @data_class ||= fields.empty? ? Data.define : Data.define(*fields.map(&:name))
    end

    #: (Hash[String, untyped]) -> untyped
    def load(hash)
      data_class.new(**fields.to_h { [_1.name, hash.fetch(_1.name.to_s)] })
    end

    # Every way `value` departs from the schema, as `path: problem` lines in
    # zod's words, so a step fails with the text the TypeScript engine gives.
    # A key the schema does not declare is no problem: as a zod object does,
    # the schema drops it (`strip`), and `dropped` names where. `strict`
    # refuses one at the root instead, as the TypeScript engine's args do.
    #: (untyped, ?String?, ?strict: bool) -> Array[String]
    def problems(value, path = nil, strict: false)
      return ["#{path || "(root)"}: #{Schema.invalid("object", value)}"] unless value.is_a?(Hash)

      hash = value.transform_keys(&:to_s)
      found = fields.flat_map do |field|
        key = join(path, field.name)
        if hash.key?(field.name.to_s) then Schema.type_problems(field.type, hash[field.name.to_s], key)
        elsif field.type == :unknown then []
        else Schema.type_problems(field.type, MISSING, key)
        end
      end
      extra = hash.keys - fields.map { _1.name.to_s }
      return found unless strict && extra.any?

      found + ["#{path || "(root)"}: Unrecognized key#{"s" if extra.size > 1}: #{extra.map { JSON.generate(_1) }.join(", ")}"]
    end

    # The value with every key the schema does not declare left out, at any
    # depth, with string keys. Assumes `problems` found none.
    #: (Hash[untyped, untyped]) -> Hash[String, untyped]
    def strip(value)
      hash = value.transform_keys(&:to_s)
      fields.to_h { [_1.name.to_s, Schema.strip_type(_1.type, hash[_1.name.to_s])] }
    end

    #: (untyped, untyped) -> untyped
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
    #: (Hash[untyped, untyped], ?String?) -> Array[String]
    def dropped(value, path = nil)
      hash = value.transform_keys(&:to_s)
      names = fields.map { _1.name.to_s }
      (hash.keys - names).map { join(path, _1) } + fields.flat_map { Schema.dropped_type(_1.type, hash[_1.name.to_s], join(path, _1.name)) }
    end

    # The keys the schema dropped, one entry per place that dropped any:
    # `at` is the place as its keys and indexes, as the TypeScript engine's
    # `returns_dropped` names it.
    #: (untyped, ?Array[String]) -> Array[Hash[Symbol, untyped]]
    def drops(value, at = [])
      return [] unless value.is_a?(Hash)

      hash = value.transform_keys(&:to_s)
      keys = hash.keys - fields.map { _1.name.to_s }
      own = keys.any? ? [{ at: at, keys: keys }] : []
      own + fields.flat_map { Schema.drops_type(_1.type, hash[_1.name.to_s], [*at, _1.name.to_s]) }
    end

    #: (untyped, untyped, Array[String]) -> Array[Hash[Symbol, untyped]]
    def self.drops_type(type, value, at)
      case type
      in [:nullable, inner] then value.nil? ? [] : drops_type(inner, value, at)
      in [:array, item] then value.is_a?(Array) ? value.each_with_index.flat_map { drops_type(item, _1, [*at, _2.to_s]) } : []
      in Schema then type.drops(value, at)
      else []
      end
    end

    #: (untyped, untyped, String) -> Array[String]
    def self.dropped_type(type, value, path)
      case type
      in [:nullable, inner] then value.nil? ? [] : dropped_type(inner, value, path)
      in [:array, item] then value.each_with_index.flat_map { dropped_type(item, _1, "#{path}[#{_2}]") }
      in Schema then type.dropped(value, path)
      else []
      end
    end

    # A key the value does not hold, which zod reads as undefined.
    MISSING = Object.new.freeze
    SAFE = 2**53 - 1

    # What zod calls a value's type in "received ...".
    #: (untyped) -> String
    def self.received(value)
      case value
      when MISSING then "undefined"
      when nil then "null"
      when String then "string"
      when true, false then "boolean"
      when Float then value.nan? ? "NaN" : "number"
      when Numeric then "number"
      when Array then "array"
      else "object"
      end
    end

    #: (String, untyped) -> String
    def self.invalid(expected, value) = "Invalid input: expected #{expected}, received #{received(value)}"

    #: (untyped, untyped, String) -> Array[String]
    def self.type_problems(type, value, path)
      problem =
        case type
        in :string then invalid("string", value) unless value.is_a?(String)
        in :boolean then invalid("boolean", value) unless [true, false].include?(value)
        in :number then invalid("number", value) unless value.is_a?(Numeric) && value.finite?
        in :integer then integer_problem(value)
        in :unknown then nil
        in [:nullable, inner] then return value.nil? ? [] : type_problems(inner, value, path)
        in [:enum, values]
          "Invalid option: expected one of #{values.map { JSON.generate(_1) }.join("|")}" unless values.include?(value.is_a?(Symbol) ? value.to_s : value)
        in [:array, item]
          return ["#{path}: #{invalid("array", value)}"] unless value.is_a?(Array)

          return value.each_with_index.flat_map { |v, i| type_problems(item, v, "#{path}.#{i}") }
        in Schema then return value.is_a?(Hash) ? type.problems(value, path) : ["#{path}: #{invalid("object", value)}"]
        end
      problem ? ["#{path}: #{problem}"] : []
    end

    # zod's int: a finite whole number within Number.MAX_SAFE_INTEGER.
    #: (untyped) -> String?
    def self.integer_problem(value)
      return invalid("number", value) unless value.is_a?(Numeric) && value.finite?
      return "Invalid input: expected int, received number" unless value == value.floor
      return "Too big: expected int to be <=#{SAFE}" if value > SAFE

      "Too small: expected int to be >=-#{SAFE}" if value < -SAFE
    end

    # The JSON Schema `nuka describe` prints, as zod's own conversion gives it:
    # the root is closed, and an inner object is closed only on the output
    # side (`returns`), where zod drops the keys it does not declare.
    #: (?root: bool, ?output: bool) -> Hash[Symbol, untyped]
    def json_schema(root: true, output: false)
      schema = { type: "object", properties: fields.to_h { [_1.name, Schema.json_type(_1.type, output).merge(_1.description ? { description: _1.description } : {})] } } #: Hash[Symbol, untyped]
      schema[:required] = fields.map(&:name) if fields.any?
      return { "$schema": "https://json-schema.org/draft/2020-12/schema", **schema, additionalProperties: false } if root

      output ? schema.merge(additionalProperties: false) : schema
    end

    #: (untyped, ?bool) -> Hash[Symbol, untyped]
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

    #: () -> Array[String]
    def rbs_fields = fields.map { "attr_reader #{_1.name}: #{Schema.rbs_type(_1.type)}" }
    #: () -> String
    def rbs_record = "{ #{fields.map { "#{_1.name}: #{Schema.rbs_type(_1.type)}" }.join(", ")} }"

    #: (untyped) -> String
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

    #: (Symbol, untyped, String?, ?bool) -> void
    def add(name, type, description, null = false) = fields << Field.new(name.to_sym, null ? [:nullable, type] : type, description)
    #: (String?, Symbol | String) -> String
    def join(path, name) = path ? "#{path}.#{name}" : name.to_s
  end
end
