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

  def test_every_teardown_runs_when_one_raises
    log = []
    cache = Nukadoko::Engine::FixtureCache.new
    cache.build(fixture(:a, log), {})
    cache.build(Nukadoko::Fixture.new(:bad, :scenario, ->(use) { use.(1); raise "no" }), {})
    error = assert_raises(RuntimeError) { cache.teardown }
    assert_equal "no", error.message
    assert_equal ["up a", "down a"], log
  end

  def test_a_fixture_that_never_calls_use_is_refused
    cache = Nukadoko::Engine::FixtureCache.new
    assert_raises(RuntimeError) { cache.build(Nukadoko::Fixture.new(:x, :scenario, ->(_use) {}), {}) }
  end
end
