# frozen_string_literal: true

# The RBS of each step, written from the same declarations check reads, so a
# project that runs Steep gets the body checked against its own contract:
# args it does not declare, a return value of the wrong shape, and, in a
# Then step, an args key the claim keeps from observe.
module Nukadoko
  module Signature
    FIXTURE_TYPES = { request: "Nukadoko::Engine::Request", page: "untyped", context: "untyped" }.freeze

    def self.of(steps)
      steps.map { of_step(_1) }.join("\n")
    end

    def self.of_step(step)
      params = step.fixtures.map { "#{_1}: #{FIXTURE_TYPES.fetch(_1, "untyped")}" } + ["args: Args"]
      returns = step.returns ? step.returns.rbs_record : "Hash[Symbol, untyped]"
      [
        "class #{step.name} < Nukadoko::Step",
        "  class Args",
        *step.inputs.rbs_fields.map { "    #{_1}" },
        "  end",
        "",
        "  def #{step.body}: (#{params.join(", ")}) -> #{returns}",
        "end",
        ""
      ].join("\n")
    end
  end
end
