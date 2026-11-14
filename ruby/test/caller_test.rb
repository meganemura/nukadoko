# frozen_string_literal: true

require "nukadoko"

class CallerTest < Minitest::Test
  class Double < Nukadoko::Step
    args { number :n, "n" }
    returns { number :twice, "twice" }
    def run(args:) = { twice: args.n * 2, extra: true }
  end

  class Composite < Nukadoko::Step
    parts [Double]
    def run(call:, args:) = { got: call.(Double, n: 2).twice }
  end

  class Bare < Nukadoko::Step
    def run(call:, args:) = call.(Double, n: 1)
  end

  def test_a_call_checks_strips_and_records
    caller = Nukadoko::Engine::Caller.new(Composite, {})
    assert_equal 4, caller.call(Double, n: 2).twice
    entry = caller.calls.first
    assert_equal Double.step_name, entry[:step]
    assert_equal({ "twice" => 4 }, entry[:result])
  end

  def test_a_part_the_step_does_not_declare_is_refused
    assert_raises(Nukadoko::Engine::Caller::Refused) { Nukadoko::Engine::Caller.new(Bare, {}).call(Double, n: 1) }
  end

  def test_wrong_args_fail_the_call_and_are_recorded
    caller = Nukadoko::Engine::Caller.new(Composite, {})
    assert_raises(TypeError) { caller.call(Double, n: "x") }
    assert_equal "args_invalid", caller.calls.first[:error][:kind]
    assert_match(/\Aargs validation failed: /, caller.calls.first[:error][:message])
  end
end
