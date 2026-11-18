# frozen_string_literal: true

require "nukadoko"

class FixtureCacheTest < Minitest::Test
  def fixture(name, log, &block)
    Nukadoko::Fixture.new(name, :scenario, block || ->(use) { log << "up #{name}"; use.(name); log << "down #{name}" })
  end

  def test_teardown_runs_in_reverse_build_order
    log = []
    cache = Nukadoko::Engine::FixtureCache.new
    cache.build(fixture(:a, log), {})
    cache.build(fixture(:b, log), {})
    cache.teardown
    assert_equal ["up a", "up b", "down b", "down a"], log
  end

  def test_every_teardown_runs_and_each_error_is_returned
    log = []
    cache = Nukadoko::Engine::FixtureCache.new
    cache.build(fixture(:a, log), {})
    cache.build(Nukadoko::Fixture.new(:bad, :scenario, ->(use) { use.(1); raise "no" }), {})
    assert_equal [{ fixture: "bad", message: "no" }], cache.teardown
    assert_equal ["up a", "down a"], log
  end

  def test_use_returns_how_the_scope_ended
    seen = []
    cache = Nukadoko::Engine::FixtureCache.new
    cache.build(Nukadoko::Fixture.new(:a, :scenario, ->(use) { seen << use.(1) }), {})
    cache.teardown("passed")
    cache.build(Nukadoko::Fixture.new(:a, :scenario, ->(use) { seen << use.(1) }), {})
    cache.teardown
    assert_equal %w[passed failed], seen
  end

  def test_a_fixture_that_never_calls_use_is_refused
    cache = Nukadoko::Engine::FixtureCache.new
    assert_raises(RuntimeError) { cache.build(Nukadoko::Fixture.new(:x, :scenario, ->(_use) {}), {}) }
  end
end
