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
    assert_equal ["kind must be [:enum, [\"a\", \"b\"]], got \"c\""], schema.problems(value.merge("kind" => "c"))
  end

  def test_nil_is_a_problem_only_where_null_is_allowed
    assert_empty schema.problems(value.merge("s" => nil))
    assert_equal ["n must be number, got nil"], schema.problems(value.merge("n" => nil))
  end

  def test_a_missing_key_is_a_problem
    assert_equal ["o.id is missing"], schema.problems(value.merge("o" => {}))
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
    assert_equal ["value must be an object, got 3"], Nukadoko::Schema.build { number :n }.problems(3)
    assert_equal ["o must be an object, got 3"], Nukadoko::Schema.build { object(:o) { number :n } }.problems({ "o" => 3 })
  end

  def test_a_list_that_is_not_an_array_is_a_problem
    assert_equal ["l must be an array, got \"x\""], Nukadoko::Schema.build { strings :l }.problems({ "l" => "x" })
  end

  def test_json_schema_lists_required_keys_and_omits_an_empty_list
    assert_equal %i[n], Nukadoko::Schema.build { number :n }.json_schema[:required]
    refute Nukadoko::Schema.new.json_schema.key?(:required)
  end
end
