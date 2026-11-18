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
        from: from(step), claims: step.claims, poll: step.poll, events: events(step), files: files(step), **states(step, steps),
        needs: step.bag.map(&:to_s).sort, needs_browser: step.bag.intersect?(BROWSER)
      }.compact
    end

    #: (singleton(Step), String, ?Array[singleton(Step)]) -> Hash[Symbol, untyped]
    def self.describe(step, project, steps = [step])
      # A step with no returns returns an empty object, as zod's default says.
      returns = step.returns&.json_schema(output: true) || { "$schema": "https://json-schema.org/draft/2020-12/schema", default: {}, type: "object", properties: {}, additionalProperties: false }
      entry(step, project, steps).merge(args: step.args.json_schema, returns: returns)
    end


    # `events` for a claim step that declares any: each key's `of` by step
    # name, and its count as declared.
    #: (singleton(Step)) -> Hash[String, Hash[Symbol, untyped]]?
    def self.events(step)
      return nil unless step.claims && step.events.any?

      step.events.transform_values do |entry|
        { of: Engine::ChangedFiles.producers(entry).map(&:step_name), count: Engine::Events::Selection.normalize(entry[:count] || entry["count"]) }
      end
    end

    # `files` for a claim step that declares any: each key's `of` by step
    # name, and its change and directory when it names them.
    #: (singleton(Step)) -> Hash[String, Hash[Symbol, untyped]]?
    def self.files(step)
      return nil unless step.claims && step.files.any?

      step.files.transform_values do |entry|
        { of: Engine::ChangedFiles.producers(entry).map(&:step_name), change: entry[:change] || entry["change"], under: Engine::ChangedFiles.under(entry) }.compact
      end
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
      browser = step.bag.intersect?(BROWSER) ? "  browser" : ""
      header = "#{step.step_name}  typed  #{step.claims ? "claims" : step.mutating? ? "mutates" : "read-only"}#{browser}#{"  timeout #{step.timeout}ms" if step.timeout}"
      items = [*(step.patterns.empty? ? ["(no pattern)"] : step.patterns), step.description]
      (events(step) || {}).each do |key, entry|
        items << "events: #{key} counts #{Engine::Events::Selection.describe(entry[:count])} of #{entry[:of].join(" or ")}"
      end
      (files(step) || {}).each do |key, entry|
        items << "files: #{key} lists the files the commands of #{entry[:of].join(" or ")} #{Engine::ChangedFiles.describe(entry)}"
      end
      (step.claims || []).each { items << "claim: #{claim_text(_1)}" }
      ((step.poll.is_a?(Hash) && step.poll[:settled]) || []).each { items << "settled: #{claim_text(_1)}" }
      states = states(step, steps)
      (states[:requires] || []).each do |use|
        items << "requires: #{use[:key] ? "#{use[:state]} for #{use[:key]}" : use[:state]}, #{use[:given_by].empty? ? "given by no step" : "given by #{use[:given_by].join(" or ")}"}"
      end
      (states[:gives] || []).each { items << "gives: #{_1[:key] ? "#{_1[:state]} for #{_1[:key]}" : _1[:state]}" }
      (states[:ends] || []).each { items << "ends: #{_1[:key] ? "#{_1[:state]} for #{_1[:key]}" : _1[:state]}" }
      [header, *items.flat_map { wrap(_1.to_s) }].join("\n")
    end

    WIDTH = 80

    # One item at two spaces, broken at spaces only, its later lines at
    # four: a pattern or a description split mid-word could not be copied
    # as the thing it names, so a word wider than the line keeps a line of
    # its own.
    #: (String) -> Array[String]
    def self.wrap(text)
      lines = [] #: Array[String]
      current = ""
      indent = 2
      text.split(/ /, -1).each do |word|
        candidate = current.empty? ? "#{" " * indent}#{word}" : "#{current} #{word}"
        if !current.empty? && candidate.size > WIDTH
          lines << current
          indent = 4
          current = "#{" " * indent}#{word}"
        else current = candidate
        end
      end
      lines << current unless current.empty?
      lines
    end

    # A declared claim as one line: `count of orders equal n`, or
    # `each of items: price greater-than 0` for a claim on each item.
    #: (Hash[Symbol, untyped]) -> String
    def self.claim_text(claim)
      return Engine::RunRecord.describe_comparison(claim) unless claim[:each]

      item = ->(entry) { Engine::RunRecord.describe_comparison({ actual: "item" }.merge(entry.compact)) }
      where = claim[:each][:where] ? " where #{claim[:each][:where].map(&item).join(" and ")}" : ""
      "each of #{claim[:actual]}#{" as #{claim[:view]}" if claim[:view]}#{" at #{claim[:at]}" if claim[:at]}#{where}: #{claim[:each][:claims].map(&item).join(" and ")}"
    end
  end
end
