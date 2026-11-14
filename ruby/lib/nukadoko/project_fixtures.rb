# frozen_string_literal: true
# rbs_inline: enabled

# Fixtures a project declares in nukadoko.config.rb. A fixture block gets
# `use` and calls it with the value; whatever follows that call is the
# teardown, as with Playwright's `use()`. The block runs in a Fiber, so the
# teardown waits until the scope ends, and runs whether the steps passed.
#
#   Nukadoko.fixture(:store) { |use| use.(Signup::Store.new) }
#   Nukadoko.fixture(:db, scope: :process) { |use, env:| db = connect(env); use.(db); db.close }
module Nukadoko
  Fixture = Data.define(
    :name, #: Symbol
    :scope, #: Symbol
    :block, #: Proc
  )

  class Fixture
    def dependencies = block.parameters.filter_map { |kind, n| n if kind == :keyreq }
  end

  #: (Symbol | String, ?scope: :scenario | :process) { (^(untyped) -> void, **untyped) -> void } -> Fixture
  def self.fixture(name, scope: :scenario, &block)
    raise ArgumentError, "scope is :scenario or :process, not #{scope.inspect}" unless %i[scenario process].include?(scope)

    project_fixtures[name.to_sym] = Fixture.new(name.to_sym, scope, block)
  end

  def self.project_fixtures = (@project_fixtures ||= {})

  module Engine
    # One scope's built fixtures, torn down in reverse build order.
    class FixtureCache
      def initialize
        @values = {}
        @fibers = []
      end

      def key?(name) = @values.key?(name)
      def [](name) = @values.fetch(name)

      def build(fixture, deps)
        fiber = Fiber.new do
          fixture.block.call(->(value) { Fiber.yield(value) }, **deps)
          :done
        end
        value = fiber.resume
        raise "fixture #{fixture.name} returned without calling use" if value == :done && !fiber.alive?

        @fibers << fiber
        @values[fixture.name] = value
      end

      # Every teardown runs; the first failure is raised after the rest.
      def teardown
        failure = nil #: StandardError?
        @fibers.reverse_each do |fiber|
          fiber.resume if fiber.alive?
        rescue StandardError => e
          failure ||= e
        end
        @fibers.clear
        @values.clear
        raise failure if failure
      end
    end
  end
end
