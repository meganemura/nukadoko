# frozen_string_literal: true
# rbs_inline: enabled

require "json"

# Responsibility: run.json's `paths` (docs/spec.md "Execution events"):
# for each pair of sides the run can compare, what each criterion's steps
# did differently on one side than on the other, as their paths say
# (events/path.rb), so a person about to turn a change on for everyone
# reads what changed in what the program did. Pure: it reads run.json's
# own fields and nothing else. Boundary: a path, and the range a count on
# it lies in, are events/path.rb's; the cells and their outcomes are the
# table's; this module adds no verdict.
#
# A pair is two sides of one criterion. Under `nuka run --base`, each
# environment's base world is paired with its head world, for the rows
# whose head cell there is required and ran. Otherwise it is two head
# environments whose declared `conditions` differ in exactly one
# condition. Steps align by their line in head's feature file, and a
# criterion whose two step lists differ is not compared. A side is read
# from its cell's first execution, since repeats and proof runs add more.
#
# Two counts are the same when both are exact and equal, changed when
# their ranges cannot meet, and open otherwise: a count a side's missing
# lines could still reach never reads as a change. A criterion whose every
# open count reads the same on both sides, under the same gap words, is
# `same_so_far`. In a pair of environments, a flag's side differing is the
# switch the pair was made to compare, so a kind PATH_KINDS marks as the
# premise is never among what changed. Against the base, it is compared as
# any kind is.
#
# A write to a table the tables list marks is compared too, and its
# difference carries what the table holds. A criterion's `result` reads
# the other differences alone, and one whose only differences are on
# marked tables is `marked_only`, never `same`: something did differ.
#
# Against the base, a changed criterion says what accounts for it: on a
# new or changed criterion, the new sentences a person approves; on an
# unchanged one, nothing in the feature files, which is the one a reader
# is sent to first.
module Nukadoko
  module Engine
    module PathView
      RESULTS = %w[changed open same_so_far marked_only same].freeze

      module_function

      # One comparison per pair of sides the run can compare: each base
      # pair, then each pair of environments, in the run's order of
      # environments; [] when there is none.
      #: (Hash[Symbol, untyped]) -> Array[Hash[Symbol, untyped]]
      def compare(doc)
        (base_pairs(doc) + condition_pairs(doc[:environments])).filter_map { compare_pair(doc, _1) }
      end

      #: (Hash[Symbol, untyped]) -> Array[Hash[Symbol, untyped]]
      def base_pairs(doc)
        return [] if doc.dig(:table, :base).nil?

        doc[:environments].map { |e| { between: { kind: "base" }, a: { world: "base", environment: e[:name] }, b: { world: "head", environment: e[:name] } } }
      end

      # Every two environments whose declared conditions differ in exactly
      # one: side `a` holds false or no value where `b` holds true, and
      # otherwise the earlier environment.
      #: (Array[Hash[Symbol, untyped]]) -> Array[Hash[Symbol, untyped]]
      def condition_pairs(environments)
        pairs = [] #: Array[Hash[Symbol, untyped]]
        environments.each_with_index do |first, index|
          environments.drop(index + 1).each do |second|
            one = (first[:conditions] || {}).transform_keys(&:to_s)
            other = (second[:conditions] || {}).transform_keys(&:to_s)
            differ = (one.keys | other.keys).reject { one[_1] == other[_1] && one.key?(_1) == other.key?(_1) }
            next unless differ.size == 1

            name = differ.first
            flipped = one[name] == true && (other[name] == false || !other.key?(name))
            a, b = flipped ? [[second, other], [first, one]] : [[first, one], [second, other]]
            pairs << { between: { kind: "condition", name: name, a: a.last.fetch(name, nil), b: b.last.fetch(name, nil) },
                       a: { world: "head", environment: a.first[:name] }, b: { world: "head", environment: b.first[:name] } }
          end
        end
        pairs
      end

      # Whether a side's world read its events: "read", "none" when no
      # base world started in the environment, or why it gave no paths.
      #: (Hash[Symbol, untyped], Hash[Symbol, untyped]) -> (String | Hash[Symbol, String])
      def reading_of(doc, side)
        world = (doc[:worlds] || []).find { (_1[:tree] || "head") == side[:world] && _1[:name] == side[:environment] }
        base = side[:world] == "base"
        return "none" if world.nil? && base

        named = base ? "the base world" : "world #{side[:environment]}"
        return { unread: "the program did not start for #{named}" } if world.nil? || !world[:error].nil?
        return { unread: "#{named} runs at #{world[:url] || "a url"}, which nukadoko did not start, so it read no execution events there" } if world.key?(:events) && world[:events].nil?
        unless world.key?(:events)
          return { unread: base ? "the base's program names no {events}, so the base world wrote no execution events" : "the program of #{named} names no {events}, so it wrote no execution events" }
        end

        "read"
      end

      #: (Hash[Symbol, untyped], Hash[Symbol, untyped]) -> String
      def side_where(pair, side)
        return side[:world] == "base" ? "at the base" : "at head" if pair.dig(:between, :kind) == "base"

        "in #{side[:environment]}"
      end

      # A side's first execution of a row, with what its cell came to, or
      # what it came to itself when the base ran it for paths alone.
      #: (Hash[Symbol, untyped], Hash[Symbol, untyped], Hash[Symbol, untyped]) -> Hash[Symbol, untyped]?
      def side_of(doc, row, side)
        scenario = doc[:scenarios].find do |entry|
          at = entry[:row] || entry
          (entry[:world] || "head") == side[:world] && entry[:environment] == side[:environment] && at[:feature] == row[:feature] && at[:line] == row[:line]
        end
        came = row[:cells].find { _1[:world] == side[:world] && _1[:environment] == side[:environment] } || scenario&.dig(:for_paths)
        return nil if scenario.nil? || came.nil?

        { scenario: scenario, execution: { scenario_record_id: scenario[:scenario_record_id], outcome: came[:outcome], line: came[:line] }.compact }
      end

      #: (Hash[Symbol, untyped], Hash[Symbol, untyped]) -> bool
      def pair_compares?(pair, row)
        return true if pair.dig(:between, :kind) == "condition"

        head = row[:cells].find { _1[:world] == "head" && _1[:environment] == pair.dig(:b, :environment) }
        !head.nil? && head[:role] == "required" && head[:outcome] != "not-run"
      end

      #: (Hash[Symbol, untyped]) -> bool
      def exact?(range) = range[:at_most] == range[:at_least]

      #: (Hash[Symbol, untyped], Hash[Symbol, untyped]) -> bool
      def apart?(one, other)
        (!one[:at_most].nil? && one[:at_most] < other[:at_least]) || (!other[:at_most].nil? && other[:at_most] < one[:at_least])
      end

      #: (Array[Hash[Symbol, untyped]]) -> Array[String]
      def gap_words(gaps) = gaps.map { _1[:gap] }.uniq.sort

      #: (Array[Hash[Symbol, untyped]]) -> Array[Hash[Symbol, untyped]]
      def unmarked(differences) = differences.select { _1[:holds].nil? }

      #: (Hash[Symbol, untyped]) -> bool
      def same_so_far?(step)
        unmarked(step[:open]).all? { _1[:a] == _1[:b] } && gap_words(step[:gaps][:a]) == gap_words(step[:gaps][:b])
      end

      # A path as events/path.rb reads it, from run.json's own shape or
      # from one read back with symbol keys: entries and requests keyed by
      # strings, gaps by symbols.
      #: (Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def path_of(path)
        { requests: JSON.parse(JSON.generate(path[:requests] || [])), entries: JSON.parse(JSON.generate(path[:entries] || [])),
          maybe: path[:maybe] || 0, open: JSON.parse(JSON.generate(path[:open] || []), symbolize_names: true) }
      end

      #: (Hash[Symbol, untyped], Hash[Symbol, untyped], ^(String) -> bool) -> Hash[Symbol, untyped]
      def step_difference(one, other, compared)
        changed = [] #: Array[Hash[Symbol, untyped]]
        open = [] #: Array[Hash[Symbol, untyped]]
        Events.keys_of(one, other).select { compared.(_1["kind"]) }.each do |key|
          ranges = { a: Events.range_on(one, key), b: Events.range_on(other, key) }
          next if exact?(ranges[:a]) && exact?(ranges[:b]) && ranges[:a][:at_least] == ranges[:b][:at_least]

          holds = Events.holds_on(other, key) || Events.holds_on(one, key)
          (apart?(ranges[:a], ranges[:b]) ? changed : open) << { **key.transform_keys(&:to_sym), **(holds.nil? ? {} : { holds: holds }), **ranges }
        end
        { changed: changed, open: open }
      end

      #: (Hash[Symbol, untyped], Hash[Symbol, untyped], Array[Hash[Symbol, untyped]], ^(String) -> bool) -> Hash[Symbol, untyped]
      def compare_criterion(pair, row, sides, compared)
        steps_a = sides[0][:scenario][:steps] || []
        steps_b = sides[1][:scenario][:steps] || []
        if steps_a.size != steps_b.size || steps_a.each_with_index.any? { |step, index| step[:line] != steps_b[index][:line] }
          return { reason: "ran steps that differ between the two sides, which run one pickle, a bug in nukadoko" }
        end

        steps = [] #: Array[Hash[Symbol, untyped]]
        steps_a.each_with_index do |step_a, index|
          step_b = steps_b[index]
          ran_a = !step_a[:record].nil?
          ran_b = !step_b[:record].nil?
          if ran_a != ran_b
            steps << { line: step_a[:line], text: step_a[:text], ran: ran_a ? "a" : "b" }
            next
          end
          next unless ran_a
          if step_a[:path].nil? || step_b[:path].nil?
            return { reason: "kept no path of its step at line #{step_a[:line] || "unknown"} #{side_where(pair, step_a[:path].nil? ? pair[:a] : pair[:b])}" }
          end

          path_a = path_of(step_a[:path])
          path_b = path_of(step_b[:path])
          found = step_difference(path_a, path_b, compared)
          next if found[:changed].empty? && found[:open].empty?

          steps << { line: step_a[:line], text: step_a[:text], ran: "both", **found, gaps: { a: Events.bounding_gaps(path_a), b: Events.bounding_gaps(path_b) } }
        end
        changed = steps.any? { _1[:ran] != "both" || unmarked(_1[:changed]).any? }
        read = steps.select { _1[:ran] != "both" || (unmarked(_1[:changed]) + unmarked(_1[:open])).any? }
        result = if changed then "changed"
                 elsif read.any? then read.all? { _1[:ran] == "both" && same_so_far?(_1) } ? "same_so_far" : "open"
                 elsif steps.any? then "marked_only"
                 else "same"
                 end
        explained = pair.dig(:between, :kind) == "base" && result == "changed" ? { explained_by: %w[new changed].include?(row[:change]) ? "criterion_change" : nil } : {}
        { criterion: { feature: row[:feature], line: row[:line], name: row[:name], result: result, **explained,
                       a: sides[0][:execution], b: sides[1][:execution], **(result == "same" ? {} : { steps: steps }) } }
      end

      #: (Hash[Symbol, untyped], Hash[Symbol, untyped]) -> Hash[Symbol, untyped]?
      def compare_pair(doc, pair)
        readings = [reading_of(doc, pair[:a]), reading_of(doc, pair[:b])]
        # Neither side read events: a run of a program that reports none
        # says nothing about paths.
        return nil unless readings.include?("read")

        empty = RESULTS.to_h { [_1.to_sym, 0] }.merge(not_compared: 0)
        why = readings.find { _1.is_a?(Hash) }
        return { **pair, unread: why[:unread], counts: empty, criteria: [], not_compared: [] } if why.is_a?(Hash)

        compared = ->(kind) { !(pair.dig(:between, :kind) == "condition" && Events.kind_rule(kind)[:condition_premise] == true) }
        criteria = [] #: Array[Hash[Symbol, untyped]]
        not_compared = [] #: Array[Hash[Symbol, untyped]]
        doc.dig(:table, :rows).each do |row|
          next if row[:verdict] == "removed" || !pair_compares?(pair, row)

          sides = [side_of(doc, row, pair[:a]), side_of(doc, row, pair[:b])]
          missing = [pair[:a], pair[:b]].each_with_index.find { |_, index| sides[index].nil? }&.first
          if missing
            not_compared << { feature: row[:feature], line: row[:line], reason: "did not run #{side_where(pair, missing)}" }
            next
          end
          found = compare_criterion(pair, row, sides.compact, compared)
          if found[:reason] then not_compared << { feature: row[:feature], line: row[:line], reason: found[:reason] }
          else criteria << found[:criterion]
          end
        end
        counts = RESULTS.to_h { |result| [result.to_sym, criteria.count { _1[:result] == result }] }.merge(not_compared: not_compared.size)
        { **pair, unread: nil, counts: counts, criteria: criteria, not_compared: not_compared }
      end
    end
  end
end
