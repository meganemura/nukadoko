# frozen_string_literal: true
# rbs_inline: enabled

# Responsibility: what each row of a change's intent came to against the
# base pairs of run.json's `paths` (docs/intent.md), and which row declares
# each difference there. Pure: it reads the comparisons, the scenarios
# they name, and each criterion's tags. Boundary: reading the intent is
# Intent's, comparing two paths PathView's; this module adds the account
# and changes no count.
#
# A row aims at a criterion that carries every tag of its target, and,
# when its target or a bare field reads a line's values, whose steps on
# either side hold an entry those values meet. A row that counts lines
# with no such term aims at every criterion its tags name, since `0 -> 1`
# must be told apart from nothing happening where nothing was there to
# see. Each criterion it aims at either did what it says or did not: a
# row meant to change declares a difference there, and one meant not to
# change finds no difference on what it observes that no other row
# declares. A row that aimed at no compared criterion was not reached.
#
# A value row declares a difference only in pairs, within one step: the
# lines that held the old value go, and as many that hold the new one
# come. A value that went somewhere else is no such pair, so neither half
# is declared.
#
# Only a decided difference (`changed`) is declared or not: an `open` one
# could still read the same. A changed criterion of a base pair whose
# every difference a row declares, with no step that ran on one side
# alone, is explained by the intent; a new or changed criterion keeps its
# own sentences as the account for the rest; anything else is a
# difference nothing the change declares asked for.
module Nukadoko
  module Engine
    module IntentView
      module_function

      #: (Hash[Symbol, untyped]) -> String
      def place_text(place) = "#{place[:feature]}:#{place[:line]}"

      # A difference's key, as a row reads it.
      #: (Hash[Symbol, untyped]) -> Hash[String, untyped]
      def key_of(difference) = difference.except(:holds, :a, :b, :intent).transform_keys(&:to_s)

      #: (Hash[Symbol, untyped]?) -> Array[Hash[String, untyped]]
      def keys_of_path(path)
        return [] if path.nil?

        read = PathView.path_of(path)
        [*read[:entries], *read[:requests].map { Events.request_key(_1) }]
      end

      # Whether a row aims at a criterion, from its tags and every entry its
      # two sides' steps hold.
      #: (Hash[Symbol, untyped], Array[String], Array[Hash[String, untyped]]) -> bool
      def aims?(row, tags, seen)
        return false unless row[:tags].all? { tags.include?(_1) }
        return true if row[:conditions].empty? && row[:projection].nil?

        # A count row's filters name what is counted, which may be absent on
        # both sides; its target alone says where it aims.
        reads = row[:projection].nil? ? row.merge(filters: []) : row
        seen.any? { Intent.observes?(reads, _1) }
      end

      # The first row that declares each difference of one step, by its
      # index among `changed`, in the rows' order: a count at once, a value
      # in pairs.
      #: (Array[Hash[Symbol, untyped]], Array[Hash[Symbol, untyped]], Array[Hash[Symbol, untyped]]) -> Hash[Integer, Integer]
      def declared(rows, aimed, changed)
        found = {} #: Hash[Integer, Integer]
        rows.each do |row|
          next unless aimed.include?(row)

          gone = [] #: Array[Integer]
          came = [] #: Array[Integer]
          changed.each_with_index do |difference, index|
            next if found.key?(index) || !Intent.observes?(row, key_of(difference))

            case Intent.declares(row, key_of(difference), difference[:a], difference[:b])
            when :count then found[index] = row[:row]
            when :gone then gone << index
            when :came then came << index
            end
          end
          # How many lines went, and how many came: a decided difference's
          # bounds on the side it shrank toward are known.
          went = gone.sum { changed.fetch(_1)[:a][:at_least] - (changed.fetch(_1)[:b][:at_most] || 0) }
          arrived = came.sum { changed.fetch(_1)[:b][:at_least] - (changed.fetch(_1)[:a][:at_most] || 0) }
          (gone + came).each { found[_1] = row[:row] } if gone.any? && came.any? && went == arrived
        end
        found
      end

      # Judges each row against the base pairs of `paths`: `{ paths:, rows: }`.
      # `tags_of` gives a criterion's tags, as head's feature file has them.
      #: (Hash[Symbol, untyped], Array[Hash[Symbol, untyped]], Array[Hash[Symbol, untyped]], Array[Hash[Symbol, untyped]], ^(Hash[Symbol, untyped]) -> Array[String]) -> Hash[Symbol, untyped]
      def judge(intent, paths, scenarios, rows, tags_of)
        by_id = scenarios.to_h { [_1[:scenario_record_id], _1] }
        change_of = rows.to_h { [place_text(_1), _1[:change]] }
        happened = intent[:rows].to_h { [_1[:row], []] } #: Hash[Integer, Array[String]]
        missed = intent[:rows].to_h { [_1[:row], []] } #: Hash[Integer, Array[String]]
        judge_one = lambda do |criterion|
          place = place_text(criterion)
          tags = tags_of.(criterion)
          sides = [by_id[criterion[:a][:scenario_record_id]], by_id[criterion[:b][:scenario_record_id]]]
          seen = sides.flat_map { (_1&.dig(:steps) || []).flat_map { |step| keys_of_path(step[:path]) } }
          aimed = intent[:rows].select { aims?(_1, tags, seen) }
          steps = (criterion[:steps] || []).map do |step|
            next step unless step[:ran] == "both"

            by_row = declared(intent[:rows], aimed, step[:changed])
            step.merge(changed: step[:changed].each_with_index.map { |difference, index| by_row.key?(index) ? difference.merge(intent: by_row[index]) : difference })
          end
          changed = steps.flat_map { _1[:ran] == "both" ? _1[:changed] : [] }
          aimed.each do |row|
            did = if row[:change].nil? then changed.none? { _1[:intent].nil? && Intent.observes?(row, key_of(_1)) }
                  else changed.any? { _1[:intent] == row[:row] }
                  end
            list = (did ? happened : missed).fetch(row[:row])
            list << place unless list.include?(place)
          end
          next(criterion[:steps].nil? ? criterion : criterion.merge(steps: steps)) unless criterion.key?(:explained_by)

          unmarked = changed.select { _1[:holds].nil? }
          by_intent = unmarked.any? && unmarked.all? { !_1[:intent].nil? } && steps.all? { _1[:ran] == "both" }
          change = change_of[place]
          explained_by = if by_intent then "intent"
                         elsif %w[new changed].include?(change) then "criterion_change"
                         end
          criterion.merge(explained_by: explained_by, steps: steps)
        end
        judged = paths.map { _1.dig(:between, :kind) == "base" ? _1.merge(criteria: _1[:criteria].map(&judge_one)) : _1 }
        order = rows.each_with_index.to_h { |row, index| [place_text(row), index] }
        places = lambda do |list|
          list.sort_by.with_index { |text, index| [order[text] || 0, index] }.map do |text|
            at = text.rindex(":").to_i
            { feature: text[0, at], line: text[(at + 1)..].to_i }
          end
        end
        judged_rows = intent[:rows].map do |row|
          missing = missed.fetch(row[:row])
          # A criterion that missed in one environment and did it in another
          # did not do it everywhere it was aimed at.
          did = happened.fetch(row[:row]) - missing
          result = if missing.any? then "not_happening"
                   elsif did.any? then "as_intended"
                   else "not_reached"
                   end
          { row: row[:row], result: result, as_intended: places.(did), not_happening: places.(missing) }
        end
        { paths: judged, rows: judged_rows }
      end

      # The findings that gate a run whose change declares an intent: each
      # problem reading it, each criterion with a difference nothing the
      # change declares, and each row that did not happen where it aimed. A
      # row not reached gates nothing. `rerun` gives the command that runs
      # one criterion against the same base.
      #: (Hash[Symbol, untyped], Array[Hash[Symbol, untyped]], ^(Hash[Symbol, untyped]) -> String) -> Array[Hash[Symbol, untyped]]
      def findings(intent, paths, rerun)
        file = intent[:file]
        found = intent[:problems].map do |problem|
          { severity: "failed", code: "intent-unread", file: file, line: problem[:line],
            message: "#{file} cannot be read as an intent: #{problem[:message]}", fix: Codes.fix("intent-unread") }.compact
        end
        unexplained = {} #: Hash[String, Hash[Symbol, untyped]]
        paths.each do |comparison|
          next unless comparison.dig(:between, :kind) == "base"

          comparison[:criteria].each { unexplained[place_text(_1)] = _1 if _1.key?(:explained_by) && _1[:explained_by].nil? }
        end
        unexplained.each_value do |criterion|
          found << { severity: "failed", code: "intent-unintended", file: criterion[:feature], line: criterion[:line],
                     message: "Scenario \"#{criterion[:name]}\" did something at head that it did not do at the base, and neither #{file} nor its sentences declare it; " \
                              "\"base → head\" in the summary lists what",
                     fix: Codes.fix("intent-unintended").to_s.gsub("INTENT.md", file), do: rerun.(criterion) }
        end
        intent[:rows].each do |row|
          next unless row[:result] == "not_happening"

          first = row[:not_happening].first
          found << { severity: "failed", code: "intent-not-happening", file: file, line: row[:line],
                     message: "row #{row[:row]} of #{file} did not happen in #{row[:not_happening].map { place_text(_1) }.join(", ")}, which its target names",
                     fix: Codes.fix("intent-not-happening"), do: first && rerun.(first) }.compact
        end
        found
      end
    end
  end
end
