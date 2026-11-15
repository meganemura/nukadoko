# frozen_string_literal: true

require "nukadoko"

class SchemaTest < Minitest::Test
  def schema
    Nukadoko::Schema.build do
      number :n, "n"
      string :s, "s", null: true
      enum :kind, %w[a b], "kind"
      object(:o, "o") { number :id }
    end
  end

  def value = { "n" => 1, "s" => nil, "kind" => "a", "o" => { "id" => 2 } }

  def test_a_value_that_fits_has_no_problems
    assert_empty schema.problems(value)
  end

  def test_an_undeclared_key_is_no_problem_and_is_dropped
    extra = value.merge("x" => 1, "o" => { "id" => 2, "y" => 3 })
    assert_empty schema.problems(extra)
    assert_equal %w[x o.y], schema.dropped(extra)
    assert_equal value, schema.strip(extra)
  end

  def test_a_word_outside_the_enum_is_a_problem
    assert_equal ["kind: Invalid option: expected one of \"a\"|\"b\""], schema.problems(value.merge("kind" => "c"))
  end

  def test_nil_is_a_problem_only_where_null_is_allowed
    assert_empty schema.problems(value.merge("s" => nil))
    assert_equal ["n: Invalid input: expected number, received null"], schema.problems(value.merge("n" => nil))
  end

  def test_a_missing_key_is_a_problem
    assert_equal ["o.id: Invalid input: expected number, received undefined"], schema.problems(value.merge("o" => {}))
  end

  def test_json_schema_closes_the_root_and_inner_objects_only_on_output
    input = schema.json_schema
    output = schema.json_schema(output: true)
    assert_equal false, input[:additionalProperties]
    refute input[:properties][:o].key?(:additionalProperties)
    assert_equal false, output[:properties][:o][:additionalProperties]
    assert_equal({ anyOf: [{ type: "string" }, { type: "null" }], description: "s" }, input[:properties][:s])
  end

  def test_rbs_names_an_enum_as_a_union_of_literals
    assert_equal '{ n: Numeric, s: (String)?, kind: "a" | "b", o: { id: Numeric } }', schema.rbs_record
  end
end

class SchemaShapeTest < Minitest::Test
  def test_a_reused_field_keeps_its_description_unless_given_one
    other = Nukadoko::Schema.build { number :id, "The id" }
    s = Nukadoko::Schema.build do
      field :a, other[:id]
      field :b, other[:id], "Mine"
    end
    assert_equal ["The id", "Mine"], s.fields.map(&:description)
    assert_equal :b, s[:b].name
  end

  def test_a_value_that_is_not_an_object_is_one_problem
    assert_equal ["(root): Invalid input: expected object, received number"], Nukadoko::Schema.build { number :n }.problems(3)
    assert_equal ["o: Invalid input: expected object, received number"], Nukadoko::Schema.build { object(:o) { number :n } }.problems({ "o" => 3 })
  end

  def test_a_list_that_is_not_an_array_is_a_problem
    assert_equal ["l: Invalid input: expected array, received string"], Nukadoko::Schema.build { strings :l }.problems({ "l" => "x" })
  end

  def test_json_schema_lists_required_keys_and_omits_an_empty_list
    assert_equal %i[n], Nukadoko::Schema.build { number :n }.json_schema[:required]
    refute Nukadoko::Schema.new.json_schema.key?(:required)
  end
end

# The texts zod 4 gives for the same schema and value, so a step fails with
# the words the TypeScript engine's would.
class SchemaZodWordsTest < Minitest::Test
  SCHEMA = Nukadoko::Schema.build do
    string :s
    number :n
    integer :i
    strings :a
    enum :e, %w[x y]
    unknown :u
    object(:o) { string :k }
  end
  FITS = { "s" => "a", "n" => 1, "i" => 1, "a" => ["a"], "e" => "x", "u" => 1, "o" => { "k" => "a" } }.freeze
  CASES = [
    [{ "s" => [1] }, ["s: Invalid input: expected string, received array"]],
    [{ "s" => {} }, ["s: Invalid input: expected string, received object"]],
    [{ "n" => Float::NAN }, ["n: Invalid input: expected number, received NaN"]],
    [{ "n" => Float::INFINITY }, ["n: Invalid input: expected number, received number"]],
    [{ "n" => true }, ["n: Invalid input: expected number, received boolean"]],
    [{ "i" => 1.5 }, ["i: Invalid input: expected int, received number"]],
    [{ "i" => "1" }, ["i: Invalid input: expected number, received string"]],
    [{ "i" => 2**60 }, ["i: Too big: expected int to be <=9007199254740991"]],
    [{ "i" => -2**60 }, ["i: Too small: expected int to be >=-9007199254740991"]],
    [{ "a" => ["a", 1] }, ["a.1: Invalid input: expected string, received number"]],
    [{ "e" => 1 }, ["e: Invalid option: expected one of \"x\"|\"y\""]],
    [{ "o" => { "k" => 1 } }, ["o.k: Invalid input: expected string, received number"]],
    [{ "o" => { "k" => "a", "extra" => 1 } }, []],
  ].freeze

  def test_each_problem_reads_as_zod_words_it
    CASES.each { |change, words| assert_equal words, SCHEMA.problems(FITS.merge(change)), change.inspect }
  end

  def test_an_unknown_key_may_be_missing
    assert_empty SCHEMA.problems(FITS.except("u"))
  end

  def test_strict_names_the_root_keys_it_does_not_declare_last
    assert_equal ["s: Invalid input: expected string, received number", "(root): Unrecognized key: \"b\""],
                 SCHEMA.problems(FITS.merge("s" => 1, "b" => 1), strict: true)
    assert_equal ["(root): Unrecognized keys: \"b\", \"c\""], SCHEMA.problems(FITS.merge("b" => 1, "c" => 2), strict: true)
    assert_equal ["(root): Invalid input: expected object, received null"], SCHEMA.problems(nil, strict: true)
  end
end
