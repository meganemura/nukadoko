# frozen_string_literal: true
# rbs_inline: enabled

# What `nuka steps` and `nuka describe` print: each step as data, in the
# fields the TypeScript engine prints, so an agent picks a step from either
# engine's vocabulary without opening a file.
module Nukadoko
  module Vocabulary
    BROWSER = %i[page context pageAs].freeze

    def self.entry(step, project)
      {
        name: step.step_name, kind: "typed", file: step.file.delete_prefix("#{project}/"),
        patterns: [step.pattern].compact, description: step.description, mutates: step.mutating?,
        parts: step.parts.empty? ? nil : step.parts.map(&:step_name),
        from: from(step), claims: step.claims, poll: step.poll,
        needs: step.bag.map(&:to_s).sort, needs_browser: step.bag.intersect?(BROWSER)
      }.compact
    end

    def self.describe(step, project)
      # A step with no returns returns an empty object, as zod's default says.
      returns = step.returns&.json_schema(output: true) || { "$schema": "https://json-schema.org/draft/2020-12/schema", default: {}, type: "object", properties: {}, additionalProperties: false }
      entry(step, project).merge(args: step.args.json_schema, returns: returns)
    end


    def self.from(step)
      return nil if step.from.empty?

      step.from.transform_values do |sources|
        named = sources.map { |cls, key| { step: cls.step_name, key: key.to_s } }
        named.size == 1 ? named.first : named
      end
    end

    def self.text(step)
      lines = ["#{step.step_name}  typed  #{step.claims ? "claims" : step.mutating? ? "mutates" : "read-only"}",
               "  #{step.pattern || "(no pattern)"}", "  #{step.description}"]
      (step.claims || []).each { lines << "  claim: #{claim_text(_1)}" }
      ((step.poll.is_a?(Hash) && step.poll[:settled]) || []).each { lines << "  settled: #{claim_text(_1)}" }
      lines.join("\n")
    end

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
