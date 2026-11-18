# frozen_string_literal: true
# rbs_inline: enabled

# What `nuka steps` and `nuka describe` print: each step as data, in the
# fields the TypeScript engine prints, so an agent picks a step from either
# engine's vocabulary without opening a file.
module Nukadoko
  module Vocabulary
    BROWSER = %i[page context pageAs page_as].freeze

    #: (singleton(Step), String, ?Array[singleton(Step)]) -> Hash[Symbol, untyped]
    def self.entry(step, project, steps = [step])
      {
        name: step.step_name, kind: "typed", file: step.file.delete_prefix("#{project}/"),
        patterns: step.patterns, description: step.description, mutates: step.mutating?, timeout: step.timeout,
        parts: step.parts.empty? ? nil : step.parts.map(&:step_name),
        from: from(step), claims: step.claims, poll: step.poll, **states(step, steps),
        needs: step.bag.map(&:to_s).sort, needs_browser: step.bag.intersect?(BROWSER)
      }.compact
    end

    #: (singleton(Step), String, ?Array[singleton(Step)]) -> Hash[Symbol, untyped]
    def self.describe(step, project, steps = [step])
      # A step with no returns returns an empty object, as zod's default says.
      returns = step.returns&.json_schema(output: true) || { "$schema": "https://json-schema.org/draft/2020-12/schema", default: {}, type: "object", properties: {}, additionalProperties: false }
      entry(step, project, steps).merge(args: step.args.json_schema, returns: returns)
    end


    # `requires`, `gives`, and `ends` for a step that declares any.
    # `given_by` names each step with a pattern whose gives names the
    # state: the steps a line can run.
    #: (singleton(Step), Array[singleton(Step)]) -> Hash[Symbol, untyped]
    def self.states(step, steps)
      declared = step.states
      return {} unless declared

      summary = ->(use) { use.key ? { state: use.state, key: use.key } : { state: use.state } }
      givers = lambda do |state|
        steps.select { |other| other.patterns.any? && other.states&.gives&.any? { _1.state == state } }.map(&:step_name)
      end
      {
        requires: declared.requires.empty? ? nil : declared.requires.map { summary.(_1).merge(given_by: givers.(_1.state)) },
        gives: declared.gives.empty? ? nil : declared.gives.map(&summary),
        ends: declared.ends.empty? ? nil : declared.ends.map(&summary)
      }.compact
    end

    #: (singleton(Step)) -> Hash[untyped, untyped]?
    def self.from(step)
      return nil if step.from.empty?

      step.from.transform_values do |sources|
        named = sources.map { |cls, key| { step: cls.step_name, key: key.to_s } }
        named.size == 1 ? named.first : named
      end
    end

    #: (singleton(Step), ?Array[singleton(Step)]) -> String
    def self.text(step, steps = [step])
      lines = ["#{step.step_name}  typed  #{step.claims ? "claims" : step.mutating? ? "mutates" : "read-only"}#{"  timeout #{step.timeout}ms" if step.timeout}",
               *(step.patterns.empty? ? ["  (no pattern)"] : step.patterns.map { "  #{_1}" }), "  #{step.description}"]
      (step.claims || []).each { lines << "  claim: #{claim_text(_1)}" }
      ((step.poll.is_a?(Hash) && step.poll[:settled]) || []).each { lines << "  settled: #{claim_text(_1)}" }
      states = states(step, steps)
      (states[:requires] || []).each do |use|
        lines << "  requires: #{use[:key] ? "#{use[:state]} for #{use[:key]}" : use[:state]}, #{use[:given_by].empty? ? "given by no step" : "given by #{use[:given_by].join(" or ")}"}"
      end
      (states[:gives] || []).each { lines << "  gives: #{_1[:key] ? "#{_1[:state]} for #{_1[:key]}" : _1[:state]}" }
      (states[:ends] || []).each { lines << "  ends: #{_1[:key] ? "#{_1[:state]} for #{_1[:key]}" : _1[:state]}" }
      lines.join("\n")
    end

    #: (Hash[Symbol, untyped]) -> String
    def self.claim_text(claim)
      return "each #{claim[:actual]}" if claim[:each]

      actual = [claim[:actual], claim[:view] && "as #{claim[:view]}", claim[:at] && "at #{claim[:at]}"].compact.join(" ")
      expected = case claim[:expected]
                 in String => key then key
                 in { literal: value } then value.to_json
                 in { from: key } then "from #{key}"
                 end
      "#{actual} #{claim[:compare]} #{expected}"
    end
  end
end
