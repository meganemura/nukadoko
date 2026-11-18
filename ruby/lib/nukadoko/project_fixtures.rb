# frozen_string_literal: true
# rbs_inline: enabled

# Fixtures a project declares in nukadoko.config.rb. A fixture block gets
# `use` and calls it with the value; whatever follows that call is the
# teardown, as with Playwright's `use()`. The block runs in a Fiber, so the
# teardown waits until the scope ends, and runs whether the steps passed.
# `use` returns how the scope ended, "passed" or "failed", so a teardown
# can keep what a failure left for a person to look at.
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
    #: () -> Array[Symbol]
    def dependencies = block.parameters.filter_map { |kind, n| n if kind == :keyreq }
  end

  #: (Symbol | String, ?scope: :scenario | :process) { (^(untyped) -> void, **untyped) -> void } -> Fixture
  def self.fixture(name, scope: :scenario, &block)
    raise ArgumentError, "scope is :scenario or :process, not #{scope.inspect}" unless %i[scenario process].include?(scope)

    project_fixtures[name.to_sym] = Fixture.new(name.to_sym, scope, block)
  end

  #: () -> Hash[Symbol, Fixture]
  def self.project_fixtures = (@project_fixtures ||= {})

  module Engine
    # One scope's built fixtures, torn down in reverse build order.
    class FixtureCache
      #: () -> void
      def initialize
        @values = {}
        @fibers = []
      end

      #: (Symbol) -> bool
      def key?(name) = @values.key?(name)
      #: (Symbol) -> untyped
      def [](name) = @values.fetch(name)

      #: (Fixture, Hash[Symbol, untyped]) -> untyped
      def build(fixture, deps)
        fiber = Fiber.new do
          fixture.block.call(->(value) { Fiber.yield(value) }, **deps)
          :done
        end
        value = fiber.resume
        raise "fixture #{fixture.name} returned without calling use" if value == :done && !fiber.alive?

        @fibers << [fixture.name, fiber]
        @values[fixture.name] = value
      end

      # Every teardown runs, and each one that raised is returned by name. A
      # cleanup error does not change the outcome of steps that already
      # passed: the caller records it and warns. Each fixture's `use`
      # returns `outcome`: a scope that did not finish is "failed".
      #: (?String) -> Array[{ fixture: String, message: String }]
      def teardown(outcome = "failed")
        errors = [] #: Array[{ fixture: String, message: String }]
        @fibers.reverse_each do |name, fiber|
          fiber.resume(outcome) if fiber.alive?
        rescue StandardError => e
          errors << { fixture: name.to_s, message: e.message }
        end
        @fibers.clear
        @values.clear
        errors
      end

      # The warnings that report teardown errors, one finding each.
      #: (Array[{ fixture: String, message: String }]) { (String) -> String } -> Array[Hash[Symbol, untyped]]
      def self.findings(errors, &redact)
        errors.map do |error|
          message = redact.("fixture \"#{error[:fixture]}\" teardown failed: #{error[:message]}").gsub(/\s*[\r\n]\s*/, " ")
          { severity: "warning", code: "fixture-teardown-failed", message: message, fix: Codes.fix("fixture-teardown-failed") }
        end
      end

      # The same warnings as stderr lines.
      #: (Array[{ fixture: String, message: String }]) { (String) -> String } -> Array[String]
      def self.warnings(errors, &redact)
        findings(errors, &redact).flat_map do |finding|
          [["warning", finding[:code], "-", finding[:message]].join("\t"), "  fix: #{finding[:fix]}"]
        end
      end
    end
  end
end
