# frozen_string_literal: true

require "nukadoko"
require "json"

# Arrays of objects and of scalars, optional and defaulted keys, and bounds,
# checked against what zod 4 gives for the same declaration.
class SchemaShapesTest < Minitest::Test
  # z.object({ todos: z.array(z.object({ id: z.string() })), scores: z.array(z.number().positive()),
  #   n: z.number().min(2).max(9), i: z.number().int().positive(), name: z.string().min(3).max(5),
  #   tags: z.array(z.string()).min(1), opt: z.string().optional(), def: z.number().default(4),
  #   optnull: z.string().nullable().optional() })
  SCHEMA = Nukadoko::Schema.build do
    array :todos do
      string :id
    end
    numbers :scores, each: { positive: true }
    number :n, min: 2, max: 9
    integer :i, positive: true
    string :name, min: 3, max: 5
    strings :tags, min: 1
    string :opt, optional: true
    number :def, default: 4
    string :optnull, null: true, optional: true
  end

  # z.toJSONSchema(..., { io: "input" }) and { io: "output" }, as zod 4.4.3 printed them.
  INPUT = '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"todos":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}},"scores":{"type":"array","items":{"type":"number","exclusiveMinimum":0}},"n":{"type":"number","minimum":2,"maximum":9},"i":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"name":{"type":"string","minLength":3,"maxLength":5},"tags":{"minItems":1,"type":"array","items":{"type":"string"}},"opt":{"type":"string"},"def":{"default":4,"type":"number"},"optnull":{"anyOf":[{"type":"string"},{"type":"null"}]}},"required":["todos","scores","n","i","name","tags"],"additionalProperties":false}'
  OUTPUT = '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"todos":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}},"scores":{"type":"array","items":{"type":"number","exclusiveMinimum":0}},"n":{"type":"number","minimum":2,"maximum":9},"i":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"name":{"type":"string","minLength":3,"maxLength":5},"tags":{"minItems":1,"type":"array","items":{"type":"string"}},"opt":{"type":"string"},"def":{"default":4,"type":"number"},"optnull":{"anyOf":[{"type":"string"},{"type":"null"}]}},"required":["todos","scores","n","i","name","tags","def"],"additionalProperties":false}'

  def test_json_schema_matches_zod
    assert_equal INPUT, JSON.generate(SCHEMA.json_schema)
    assert_equal OUTPUT, JSON.generate(SCHEMA.json_schema(output: true))
  end

  def test_problems_match_zod
    value = { "todos" => [{ "id" => 1 }], "scores" => [0, -1], "n" => 1, "i" => 0, "name" => "ab", "tags" => [], "opt" => 3 }
    assert_equal [
      "todos.0.id: Invalid input: expected string, received number",
      "scores.0: Too small: expected number to be >0",
      "scores.1: Too small: expected number to be >0",
      "n: Too small: expected number to be >=2",
      "i: Too small: expected number to be >0",
      "name: Too small: expected string to have >=3 characters",
      "tags: Too small: expected array to have >=1 items",
      "opt: Invalid input: expected string, received number",
    ], SCHEMA.problems(value)
    big = Nukadoko::Schema.build do
      number :n, max: 9
      string :name, max: 5
      strings :tags, max: 1
    end
    assert_equal [
      "n: Too big: expected number to be <=9",
      "name: Too big: expected string to have <=5 characters",
      "tags: Too big: expected array to have <=1 items",
    ], big.problems({ "n" => 10, "name" => "abcdef", "tags" => %w[a b] })
  end

  def test_absent_optional_and_default_keys
    value = { "todos" => [], "scores" => [], "n" => 2, "i" => 1, "name" => "abc", "tags" => ["x"] }
    assert_equal [], SCHEMA.problems(value)
    loaded = SCHEMA.load(value)
    assert_nil loaded.opt
    assert_equal 4, loaded.def
    assert_equal %w[todos scores n i name tags], SCHEMA.required_names
    assert_equal({ "todos" => [], "scores" => [], "n" => 2, "i" => 1, "name" => "abc", "tags" => ["x"], "def" => 4 }, SCHEMA.strip(value))
  end

  def test_rbs_reads_an_absent_optional_key_as_nil
    assert_includes SCHEMA.rbs_record, "opt: (String)?"
    assert_includes SCHEMA.rbs_record, "todos: Array[{ id: String }]"
    assert_includes SCHEMA.rbs_record, "def: Numeric"
  end

  def test_unknown_option_is_refused
    error = assert_raises(ArgumentError) { Nukadoko::Schema.build { string :x, minimum: 1 } }
    assert_includes error.message, "minimum:"
  end
end
