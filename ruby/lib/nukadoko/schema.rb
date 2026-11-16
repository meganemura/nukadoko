# frozen_string_literal: true
# rbs_inline: enabled

# One declaration of a step's args or returns gives three things: the check
# a value must pass at run time, the RBS a Steep user checks the step body
# against, and the Data class the body receives. A type is a symbol for a
# scalar, `[:array, type]` for a list, or a nested Schema for an object.
# `[:checked, type, checks]` is an array item with bounds of its own.
#
# Each field method takes the options zod spells as methods: `null: true`
# (`.nullable()`), `optional: true` (`.optional()`: the key may be absent,
# and the body reads nil), `default:` (`.default(x)`: an absent key reads
# as the value), and bounds: `min:` and `max:` (a number's value, a
# string's length, an array's item count), `positive: true` (> 0) and
# `negative: true` (< 0).
module Nukadoko
  class Schema
    # The value of `default` when the field declares none.
    NONE = Object.new.freeze

    Field = Data.define(
      :name, #: Symbol
      :type, #: untyped
      :description, #: String?
      :optional, #: bool
      :default, #: untyped
      :checks, #: Hash[Symbol, untyped]
    )

    class Field
      # An absent key passes: the field is optional or has a default.
      #: () -> bool
      def absent_ok? = optional || default?

      #: () -> bool
      def default? = !NONE.equal?(default)
    end

    CHECKS = %i[min max positive negative].freeze

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

    #: (Symbol, ?String?, **untyped) -> void
    def string(name, description = nil, **options) = add(name, :string, description, **options)
    #: (Symbol, ?String?, **untyped) -> void
    def boolean(name, description = nil, **options) = add(name, :boolean, description, **options)
    #: (Symbol, ?String?, **untyped) -> void
    def integer(name, description = nil, **options) = add(name, :integer, description, **options)
    #: (Symbol, ?String?, **untyped) -> void
    def number(name, description = nil, **options) = add(name, :number, description, **options)
    #: (Symbol, ?String?, **untyped) -> void
    def unknown(name, description = nil, **options) = add(name, :unknown, description, **options)
    #: (Symbol, Array[String | Symbol], ?String?, **untyped) -> void
    def enum(name, values, description = nil, **options) = add(name, [:enum, values.map(&:to_s)], description, **options)
    #: (Symbol, ?String?, **untyped) -> void
    def strings(name, description = nil, **options) = array(name, description, of: :string, **options)
    #: (Symbol, ?String?, **untyped) -> void
    def numbers(name, description = nil, **options) = array(name, description, of: :number, **options)
    #: (Symbol, ?String?, **untyped) -> void
    def integers(name, description = nil, **options) = array(name, description, of: :integer, **options)
    #: (Symbol, ?String?, **untyped) -> void
    def table(name, description = nil, **options) = add(name, [:array, [:array, :string]], description, **options)
    #: (Symbol, ?String?, **untyped) { () [self: Schema] -> void } -> void
    def object(name, description = nil, **options, &block) = add(name, Schema.build(&block), description, **options)

    # A list: of objects the block declares (`array :todos do string :id end`),
    # or of `of:` (:string, :number, :integer, :boolean, or a Schema).
    # `each:` holds bounds every item meets (`each: { positive: true }`);
    # `min:` and `max:` bound the item count.
    #: (Symbol, ?String?, ?of: untyped, ?each: Hash[Symbol, untyped], **untyped) ?{ () [self: Schema] -> void } -> void
    def array(name, description = nil, of: nil, each: {}, **options, &block)
      item = block ? Schema.build(&block) : of
      raise ArgumentError, "array :#{name} needs of: or a block that declares its items" if item.nil?

      unknown = each.keys - CHECKS
      raise ArgumentError, "array :#{name} each: takes #{CHECKS.join(", ")}, not #{unknown.join(", ")}" if unknown.any?

      add(name, [:array, each.empty? ? item : [:checked, item, each]], description, **options)
    end

    # Reuses a field another step declared, so two contracts that must agree
    # on one shape are written once: `field :created, AnItemExists.returns[:body]`.
    #: (Symbol, Field, ?String?) -> void
    def field(name, other, description = nil) = fields << other.with(name: name.to_sym, description: description || other.description)

    #: (Symbol | String) -> Field?
    def [](name) = fields.find { _1.name == name.to_sym }

    # The keys a value must hold: neither optional nor defaulted.
    #: () -> Array[String]
    def required_names = fields.reject { _1.absent_ok? }.map { _1.name.to_s }

    #: (Array[String]) -> Schema
    def without(names) = Schema.new(fields.reject { names.include?(_1.name.to_s) })

    #: () -> untyped
    def data_class
      @data_class ||= fields.empty? ? Data.define : Data.define(*fields.map(&:name))
    end

    #: (Hash[String, untyped]) -> untyped
    def load(hash)
      data_class.new(**fields.to_h { |field| [field.name, hash.fetch(field.name.to_s) { field.default? ? field.default : (field.optional ? nil : hash.fetch(field.name.to_s)) }] })
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
        if hash.key?(field.name.to_s)
          found = Schema.type_problems(field.type, hash[field.name.to_s], key)
          found.empty? ? Schema.check_problems(field.checks, hash[field.name.to_s], key) : found
        elsif field.type == :unknown || field.absent_ok? then []
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
      kept = {} #: Hash[String, untyped]
      fields.each do |field|
        key = field.name.to_s
        if hash.key?(key) then kept[key] = Schema.strip_type(field.type, hash[key])
        elsif field.default? then kept[key] = field.default
        elsif !field.optional then kept[key] = nil
        end
      end
      kept
    end

    #: (untyped, untyped) -> untyped
    def self.strip_type(type, value)
      case type
      in [:nullable, inner] then value.nil? ? nil : strip_type(inner, value)
      in [:array, item] then value.map { strip_type(item, _1) }
      in [:checked, inner, _] then strip_type(inner, value)
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
      in [:checked, inner, _] then drops_type(inner, value, at)
      in Schema then type.drops(value, at)
      else []
      end
    end

    #: (untyped, untyped, String) -> Array[String]
    def self.dropped_type(type, value, path)
      case type
      in [:nullable, inner] then value.nil? ? [] : dropped_type(inner, value, path)
      in [:array, item] then value.each_with_index.flat_map { dropped_type(item, _1, "#{path}[#{_2}]") }
      in [:checked, inner, _] then dropped_type(inner, value, path)
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
        in [:checked, inner, checks]
          found = type_problems(inner, value, path)
          return found.empty? ? check_problems(checks, value, path) : found
        in Schema then return value.is_a?(Hash) ? type.problems(value, path) : ["#{path}: #{invalid("object", value)}"]
        end
      problem ? ["#{path}: #{problem}"] : []
    end

    # A bound zod reports in its own words, once the type passed: a number's
    # value, a string's length in UTF-16 units, an array's item count.
    #: (Hash[Symbol, untyped], untyped, String) -> Array[String]
    def self.check_problems(checks, value, path)
      return [] if checks.empty? || value.nil?

      size, what, unit = case value
                         when String then [value.encode("UTF-16LE").bytesize / 2, "string", " characters"]
                         when Array then [value.size, "array", " items"]
                         when Numeric then [value, "number", ""]
                         else return []
                         end
      relation = what == "number" ? "be" : "have"
      bounds = [] #: Array[String]
      bounds << "Too small: expected #{what} to #{relation} >0#{unit}" if checks[:positive] && size <= 0
      bounds << "Too small: expected #{what} to #{relation} >=#{js(checks[:min])}#{unit}" if checks.key?(:min) && size < checks[:min]
      bounds << "Too big: expected #{what} to #{relation} <0#{unit}" if checks[:negative] && size >= 0
      bounds << "Too big: expected #{what} to #{relation} <=#{js(checks[:max])}#{unit}" if checks.key?(:max) && size > checks[:max]
      bounds.map { "#{path}: #{_1}" }
    end

    # A number as JavaScript prints it: 2.0 is 2.
    #: (Numeric) -> String
    def self.js(number) = number.is_a?(Float) && number == number.floor && number.finite? ? number.to_i.to_s : number.to_s

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
      properties = fields.to_h do |field|
        type = Schema.json_type(field.type, output, field.checks)
        type = { default: field.default, **type } if field.default?
        [field.name, type.merge(field.description ? { description: field.description } : {})]
      end
      schema = { type: "object", properties: properties } #: Hash[Symbol, untyped]
      # zod's output side always holds a defaulted key; the input may leave it out.
      required = fields.reject { _1.optional || (_1.default? && !output) }.map(&:name)
      schema[:required] = required if required.any?
      return { "$schema": "https://json-schema.org/draft/2020-12/schema", **schema, additionalProperties: false } if root

      output ? schema.merge(additionalProperties: false) : schema
    end

    # As z.toJSONSchema writes it, bounds included and in its key order.
    #: (untyped, ?bool, ?Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
    def self.json_type(type, output = false, checks = {})
      case type
      in :string then { type: "string", **length_bounds(checks, :minLength, :maxLength) }
      in :boolean then { type: "boolean" }
      in :integer
        { type: "integer", **number_bounds(checks, -SAFE, SAFE) }
      in :number then { type: "number", **number_bounds(checks, nil, nil) }
      in :unknown then {}
      in [:nullable, inner] then { anyOf: [json_type(inner, output, checks), { type: "null" }] }
      in [:enum, values] then { type: "string", enum: values }
      in [:array, item] then { **length_bounds(checks, :minItems, :maxItems), type: "array", items: json_type(item, output) }
      in [:checked, inner, own] then json_type(inner, output, own)
      in Schema then type.json_schema(root: false, output: output)
      end
    end

    #: (Hash[Symbol, untyped], Integer?, Integer?) -> Hash[Symbol, untyped]
    def self.number_bounds(checks, floor, ceiling)
      low = if checks[:positive] then { exclusiveMinimum: 0 }
            elsif checks.key?(:min) then { minimum: checks[:min] }
            elsif floor then { minimum: floor }
            else {}
            end
      high = if checks[:negative] then { exclusiveMaximum: 0 }
             elsif checks.key?(:max) then { maximum: checks[:max] }
             elsif ceiling then { maximum: ceiling }
             else {}
             end
      { **low, **high }
    end

    #: (Hash[Symbol, untyped], Symbol, Symbol) -> Hash[Symbol, untyped]
    def self.length_bounds(checks, low, high)
      { **(checks.key?(:min) ? { low => checks[:min] } : {}), **(checks.key?(:max) ? { high => checks[:max] } : {}) }
    end

    #: () -> Array[String]
    def rbs_fields = fields.map { "attr_reader #{_1.name}: #{Schema.rbs_field(_1)}" }
    #: () -> String
    def rbs_record = "{ #{fields.map { "#{_1.name}: #{Schema.rbs_field(_1)}" }.join(", ")} }"

    # An optional key reads as nil when it is absent.
    #: (Field) -> String
    def self.rbs_field(field) = field.optional && !field.default? ? "(#{rbs_type(field.type)})?" : rbs_type(field.type)

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
      in [:checked, inner, _] then rbs_type(inner)
      in Schema then type.fields.empty? ? "Hash[Symbol, untyped]" : type.rbs_record
      end
    end

    private

    #: (Symbol, untyped, String?, ?null: bool, ?optional: bool, ?default: untyped, **untyped) -> void
    def add(name, type, description, null: false, optional: false, default: NONE, **checks)
      unknown = checks.keys - CHECKS
      raise ArgumentError, ":#{name} takes null:, optional:, default:, #{CHECKS.map { "#{_1}:" }.join(", ")}, not #{unknown.map { "#{_1}:" }.join(", ")}" if unknown.any?

      fields << Field.new(name: name.to_sym, type: null ? [:nullable, type] : type, description: description, optional: optional, default: default, checks: checks)
    end
    #: (String?, Symbol | String) -> String
    def join(path, name) = path ? "#{path}.#{name}" : name.to_s
  end
end
