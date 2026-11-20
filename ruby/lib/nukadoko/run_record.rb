# frozen_string_literal: true
# rbs_inline: enabled

require "open3"
require "tmpdir"

# The shapes a run writes, in the TypeScript engine's run.json format: a
# claim as the step judged it with where each side came from, a row's
# verdict and the sentence that says why, the counts, and the commit the
# run judged. One reader reads a run from either engine; a field this
# engine cannot fill is null rather than missing.
module Nukadoko
  module Engine
    module RunRecord
      SCHEMA_VERSION = 4

      module_function

      # A step's record.json as `nuka run` writes it, in the TypeScript engine's
      # shape, from what the run kept of the step. The keywords name where it ran:
      # the environment, the world, the run, the scenario, and the step's own
      # directory. A record that passed names each step it used; a failed one
      # names what each gave too, since that is what it failed on.
      #: (Hash[Symbol, untyped], environment: String, world_name: String?, run_id: String?, scenario_record_id: String?, evidence_dir: String, ?target_version: String?) -> Hash[Symbol, untyped]
      def step_file(record, environment:, world_name:, run_id:, scenario_record_id:, evidence_dir:, target_version: nil)
        passed = record[:status] == "passed"
        # A compat step returns nothing nukadoko reads, so its result is null.
        outcome = if passed && record[:mutates].nil? && record[:kind] != "claim" && record[:step].to_s.start_with?("compat: ") then { result: nil }
                  elsif passed then { result: record[:result] || {}, returns_dropped: record[:returns_dropped] }.compact
                  else { error: { message: record[:error], kind: record[:error_kind], **(record[:error_at]&.any? ? { at: record[:error_at] } : {}) } }
                  end
        processes = record[:processes]
        used = (record[:used] || []).map do |entry|
          { step_record_id: File.basename(entry[:record]), step: entry[:step], **(passed ? {} : { result: entry[:result] }) }
        end
        { schema_version: SCHEMA_VERSION, nukadoko: VERSION, step_record_id: record[:step_record_id], step: record[:step], kind: "run",
          args: record[:args] || {}, **(record[:args_origin]&.any? ? { args_origin: record[:args_origin] } : {}),
          **outcome, status: record[:status], environment: environment, world_name: world_name,
          **(target_version ? { target_version: target_version } : {}),
          scenario_record_id: scenario_record_id, run_id: run_id, started_at: record[:started_at], finished_at: record[:finished_at],
          evidence: { dir: evidence_dir, screenshots: [], **(record[:attachments] ? { attachments: record[:attachments] } : {}),
                      **(record[:scratch] ? { scratch: record[:scratch] } : {}),
                      **(record[:http_file] ? { http: "http.jsonl" } : {}), **(record[:mcp_count] ? { mcp: McpCalls::FILE } : {}),
                      **(record[:trace] ? { trace: record[:trace] } : {}),
                      **(record[:named_traces] ? { named_traces: record[:named_traces] } : {}) },
          observed: { processes: processes&.any? ? processes : nil, http: record[:http_count].to_i.positive? ? record[:http_count] : nil,
                      files: record[:files], unmeasured: [], **(record[:mcp_count] ? { mcp: record[:mcp_count] } : {}),
                      **(record.key?(:program_log) ? { program_log: record[:program_log] } : {}),
                      **(record.key?(:events) ? { events: record[:events] } : {}) },
          mutates: record[:mutates], **(record[:page_events] ? { page_events: record[:page_events] } : {}),
          **(record[:http_omitted] ? { http_omitted: record[:http_omitted] } : {}), **(used.any? ? { used: used } : {}), **(record[:sections] ? { sections: record[:sections] } : {}),
          **(record[:calls] ? { calls: record[:calls] } : {}), **(record[:polls] ? { polls: record[:polls] } : {}),
          **(record[:required_env] ? { required_env: record[:required_env] } : {}),
          **(record[:actions] ? { actions: record[:actions] } : {}), **(record[:actions_truncated] || record[:attachments_total] ? { truncated: { actions: record[:actions_truncated], evidence: record[:attachments_total] }.compact } : {}),
          **(record[:fixtures] ? { fixtures: record[:fixtures] } : {}),
          **(record[:claim_records] ? { claims: record[:claim_records], observation: record[:observation] || "observed", **poll_fields(record), **read_fields(record) } : {}) }
      end

      # One comparison, as run.json's steps[].claims[] holds it. `origins`
      # maps an args key to the label of where its value came from, and
      # `texts` to the text the sentence stated it as.
      #: (Hash[Symbol, untyped], Hash[Symbol, untyped], Hash[String, String], Hash[String, String?], observed: bool, ?patterns: Array[String]) -> Hash[Symbol, untyped]
      def claim(declared, judged, origins, texts, observed:, patterns: [])
        actual_key = declared[:actual].to_s
        base = if observed then "observe:#{actual_key}"
               else origins.fetch(actual_key, "sentence:#{actual_key}")
               end
        actual_from = counted(place(base, declared[:view], declared[:at]), declared[:count])
        actual_from = "ARIA snapshot of #{base}" if declared[:compare] == "fits-aria-snapshot"
        actual_from = "ARIA snapshot of observe:#{Claims.judged_path(declared)}" if judged[:aria]
        expected_from, expected_text = expected_origin(declared, origins, texts, patterns)
        { **judged.slice(:actual, :actual_range, :counted, :left_out), actual_from: actual_from, **{ view: declared[:view], at: declared[:at]&.to_s, count: declared[:count] }.compact,
          compare: declared[:compare], **judged.slice(:expected), expected_from: expected_from,
          **{ expected_view: declared[:expected_view] }.compact }.merge(expected_text: expected_text, **outcome(judged), measured: nil)
      end

      READING_MAX_BYTES = 1024

      # What the page received and showed, with each events key's reading
      # before the judged view, in the TypeScript engine's order.
      #: (Hash[Symbol, untyped], ?String?) -> Hash[Symbol, untyped]
      def read_fields(record, under = nil)
        page = page_fields(record, under)
        { **page.except(:judged_view), **(record[:events_read] ? { events_read: record[:events_read] } : {}), **page.slice(:judged_view) }
      end

      # What a claim step's page had received by its judged reading, and
      # what the page showed right after it. A file is named from the step
      # record's directory, or from the run's when `under` names the step's.
      #: (Hash[Symbol, untyped], ?String?) -> Hash[Symbol, untyped]
      def page_fields(record, under = nil)
        view = record[:page_view] or return {}
        return view unless under && view[:judged_view]

        pages = view[:judged_view][:pages].map do |page|
          page.merge(%i[screenshot aria].to_h { |key| [key, page[key] && page[key].merge(file: File.join(under, page[key][:file]))] })
        end
        view.merge(judged_view: view[:judged_view].merge(pages: pages))
      end

      # How many times a claim step read, and for a polled one each reading
      # and the settled conditions, with the reading the poll stopped on
      # when two settled.
      #: (Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def poll_fields(record)
        poll = record[:poll] or return { attempts: 1 }

        readings = record[:readings].map do |reading|
          { attempt: reading[:attempt], at: reading[:at], held: reading[:holds],
            **(reading[:error] ? { error: reading[:error] } : { actuals: reading[:actuals].map { reading_value(_1) } }),
            **(reading.key?(:settled) ? { settled: reading[:settled] } : {}) }
        end
        settled = if poll[:conditions].any?
                    last = readings.last
                    stop = poll[:stop] == "settled" ? { stop: { reading: last[:attempt], actuals: last[:actuals] } } : {}
                    { settled: { conditions: poll[:conditions], **stop } }
                  else {}
                  end
        { attempts: [readings.size, 1].max, readings: readings, **settled }
      end

      #: (untyped) -> Hash[Symbol, untyped]
      def reading_value(value)
        text = JSON.generate(value)
        text.bytesize <= READING_MAX_BYTES ? { value: value } : { json_start: text.byteslice(0, READING_MAX_BYTES).to_s.scrub(""), json_bytes: text.bytesize }
      end

      # Why a poll whose claim broke stopped, on the failure's first line,
      # so a reading that settled is never mistaken for the timeout passing.
      #: (singleton(Step), Hash[Symbol, untyped]) -> String
      def poll_end(step, record)
        poll = record[:poll]
        return "" if poll.nil? || poll[:conditions].empty? || poll[:stop] == "held"

        conditions = poll[:conditions].join(" and ")
        attempts = record[:readings].size
        if poll[:stop] == "settled"
          "; the poll stopped on reading #{attempts}, before its #{step.poll[:timeout_ms]} ms timeout, since readings #{attempts - 1} and #{attempts} settled (#{conditions})"
        else
          "; the poll read until its #{step.poll[:timeout_ms]} ms timeout, and no two consecutive readings settled (#{conditions})"
        end
      end

      # A declared claim or settled condition as one line, as `nuka
      # describe` writes it: `status not-equal "running"`.
      #: (Hash[Symbol, untyped]) -> String
      def describe_comparison(claim)
        expected = case claim[:expected]
                   in String => key then key
                   in { from: key } then "from #{key}"
                   in { observe: key } then "observe #{key}"
                   in { literal: value } then JSON.generate(value)
                   end
        "#{"count of " if claim[:count]}#{claim[:actual]}#{" as #{claim[:view]}" if claim[:view]}#{" at #{claim[:at]}" if claim[:at]} " \
          "#{claim[:compare]} #{expected}#{" as #{claim[:expected_view]}" if claim[:expected_view]}"
      end

      EACH_RESULTS_CAP = 20
      IDENTITY_FIELDS = %w[id name key].freeze

      # A claim on each item of a list, as run.json holds it: each `where`
      # and item claim as declared, how many items the list held and how
      # many `where` selected, and the judged items, the broken first, at
      # most 20, in index order.
      #: (Hash[Symbol, untyped], Engine::ClaimSides::Inputs, Hash[String, String], Hash[String, String?], ?patterns: Array[String]) -> Hash[Symbol, untyped]
      def each_claim(declared, inputs, origins, texts, patterns: [])
        sides = Engine::ClaimSides
        args = inputs.args
        observed = inputs.observed
        each = declared[:each]
        where = each[:where] || []
        declarations = { **(where.empty? ? {} : { where: where.map { item_declaration(_1, args, origins, texts, patterns, observed) } }),
                         claims: each[:claims].map { item_declaration(_1, args, origins, texts, patterns, observed) } }
        array = sides.array_side(declared, inputs)
        base = { actual_from: array.place.label, view: declared[:view], at: declared[:at]&.to_s }.compact
        value = array.found[:value]
        count = value.is_a?(Array) ? value.size : 0
        ended = lambda do |reason, results = [], outcome = "broken"|
          base.merge(each: { **declarations, items: count, selected: 0, results: results }, outcome: outcome, reason: reason, measured: nil)
        end
        stop = array.found.slice(:broken, :unjudged).then { _1.empty? ? nil : _1 } || sides.each_stop(declared, array.place, inputs)
        return ended.(stop[:broken] || stop[:unjudged], [], stop[:unjudged] ? "unjudged" : "broken") if stop
        return ended.("each reads an array, and the value is #{article(json_type(value))}") unless value.is_a?(Array)
        return ended.("the array is empty, and a claim on every item of nothing measures nothing") if value.empty?

        judged = []
        value.each_with_index do |item, index|
          place = sides.place_at(array.place, index.to_s)
          compare = ->(entry) { item_comparison(entry, sides.item_side(item, place, entry), inputs, origins, texts, patterns) }
          where_records = where.map(&compare)
          # A where claim that could not compare says nothing about whether
          # the item belongs, so leaving it out would turn "every item" into
          # "the items that happen to compare".
          if (unjudgeable = where_records.find { _1[:reason] })
            outcome = unjudgeable[:outcome] == "unjudged" ? "unjudged" : "broken"
            return ended.("where could not #{outcome == "unjudged" ? "judge" : "compare"} item #{index}: #{unjudgeable[:reason]}",
                          [{ index: index, selected: false, where: where_records }], outcome)
          end
          next judged << { index: index, selected: false, where: where_records } unless where_records.all? { _1[:outcome] == "held" }

          claims = each[:claims].map(&compare)
          outcome = claims.any? { _1[:outcome] == "broken" } ? "broken" : claims.any? { _1[:outcome] == "unjudged" } ? "unjudged" : "held"
          identity = outcome == "broken" && item.is_a?(Hash) && IDENTITY_FIELDS.lazy.filter_map do |field|
            v = item.transform_keys(&:to_s)[field]
            { field: field, value: v } if v.is_a?(String) || (v.is_a?(Numeric) && v.finite?)
          end.first
          judged << { index: index, selected: true, **(where_records.empty? ? {} : { where: where_records }), outcome: outcome, claims: claims,
                      **(identity ? { identity: identity } : {}) }
        end
        selected = judged.count { _1[:selected] }
        rank = ->(entry) { !entry[:selected] ? 2 : { "broken" => 0, "unjudged" => 1 }.fetch(entry[:outcome], 3) }
        kept = judged.sort_by { [rank.(_1), _1[:index]] }.first(EACH_RESULTS_CAP).sort_by { _1[:index] }
        truncated = judged.size > kept.size ? { results_truncated: judged.size } : {}
        record = base.merge(each: { **declarations, items: value.size, selected: selected, results: kept, **truncated })
        if selected.zero?
          return record.merge(outcome: "broken", reason: "where selected none of the #{value.size} items, and a claim on none of them measures nothing", measured: nil)
        end

        outcomes = judged.select { _1[:selected] }.map { _1[:outcome] }
        record.merge(outcome: outcomes.include?("broken") ? "broken" : outcomes.include?("unjudged") ? "unjudged" : "held", measured: nil)
      end

      #: (Hash[Symbol, untyped], untyped, Hash[String, String], Hash[String, String?], Array[String], untyped) -> Hash[Symbol, untyped]
      def item_declaration(entry, args, origins, texts, patterns, observed)
        expected_from, expected_text = expected_origin(entry, origins, texts, patterns)
        expected = begin
          { expected: Claims.expected_value(entry, args, observed) }
        rescue StandardError
          {}
        end
        { actual: entry[:actual]&.to_s, view: entry[:view], at: entry[:at]&.to_s, count: entry[:count] }.compact
          .merge(compare: entry[:compare], **expected, expected_from: expected_from, **(entry[:expected_view] ? { expected_view: entry[:expected_view] } : {}),
                 expected_text: expected_text)
      end

      # One where or item claim on one item, judged on the side the item gives.
      #: (Hash[Symbol, untyped], Engine::ClaimSides::Side, Engine::ClaimSides::Inputs, Hash[String, String], Hash[String, String?], Array[String]) -> Hash[Symbol, untyped]
      def item_comparison(entry, side, inputs, origins, texts, patterns)
        sides = Engine::ClaimSides
        judged = sides.judge_comparison(entry, side, inputs)
        label = sides.place_counted(sides.place_at(sides.place_viewed(side.place, entry[:view]), entry[:at]&.to_s), entry[:count]).label
        expected_from, expected_text = expected_origin(entry, origins, texts, patterns)
        { **judged.slice(:actual), actual_from: label, **{ view: entry[:view], at: entry[:at]&.to_s, count: entry[:count] }.compact }
          .merge(compare: entry[:compare], **judged.slice(:expected), expected_from: expected_from,
                 **(entry[:expected_view] ? { expected_view: entry[:expected_view] } : {}), expected_text: expected_text,
                 **outcome(judged))
      end

      # The claims of a scenario's step records, counted by outcome, in the
      # fields run.json gives them.
      #: (Array[Hash[Symbol, untyped]]) -> Hash[Symbol, Integer]
      def claim_counts(records)
        outcomes = records.flat_map { _1[:claim_records] || [] }.map { _1[:outcome] }
        counts = { held: outcomes.count("held"), broken: outcomes.count("broken") } #: Hash[Symbol, Integer]
        { unobserved: "unobserved", unjudged: "unjudged", for_judgment: "for-judgment" }.each do |key, outcome|
          counts[key] = outcomes.count(outcome) if outcomes.include?(outcome)
        end
        counts
      end

      # A claim's outcome and, when the two sides could not be compared or
      # nothing judged them, why.
      #: (Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def outcome(judged)
        return { outcome: "for-judgment" } if judged[:for_judgment]
        return { outcome: "held" } if judged[:holds]

        { outcome: judged[:unjudged] ? "unjudged" : "broken", **(judged[:reason] ? { reason: judged[:reason] } : {}) }
      end

      #: (untyped) -> String
      def json_type(value)
        case value
        when nil then "null"
        when true, false then "boolean"
        when Numeric then "number"
        when String then "string"
        when Array then "array"
        else "object"
        end
      end

      #: (String) -> String
      def article(type) = %w[array object].include?(type) ? "an #{type}" : "a #{type}"

      # A claim whose observe raised: where each side would come from, and no value.
      #: (Hash[Symbol, untyped], Hash[String, String], Hash[String, String?], ?patterns: Array[String]) -> Hash[Symbol, untyped]
      def unobserved_claim(declared, origins, texts, patterns: [])
        expected_from, expected_text = expected_origin(declared, origins, texts, patterns)
        { actual_from: declared[:compare] == "fits-aria-snapshot" ? "ARIA snapshot of observe:#{declared[:actual]}" : place("observe:#{declared[:actual]}", declared[:view], declared[:at]), view: declared[:view], at: declared[:at]&.to_s,
          count: declared[:count], compare: declared[:compare], expected_from: expected_from, expected_view: declared[:expected_view], expected_text: expected_text,
          outcome: "unobserved" }.compact.merge(measured: nil).tap { _1[:actual_from] = counted(_1[:actual_from], declared[:count]) }
      end

      # A count is the last step a claim takes, so its label names it first.
      #: (String, untyped) -> String
      def counted(label, count) = count ? "count of #{label}" : label

      # Where a side of a claim reads: its origin, read through its view,
      # then walked to its path, as the TypeScript engine labels it.
      #: (String, String?, untyped) -> String
      def place(base, view, at)
        label = view ? "#{base} as #{view}" : base
        return label unless at

        "#{label}#{view ? " at " : "."}#{at}"
      end

      # A literal is named by the pattern words that state it, so the label
      # reads as the sentence did.
      #: (Hash[Symbol, untyped], Hash[String, String], Hash[String, String?], Array[String]) -> [String, String?]
      def expected_origin(declared, origins, texts, patterns)
        case declared[:expected]
        in String => key then [place(origins.fetch(key, "sentence:#{key}"), declared[:expected_view], nil), texts[key]]
        in { from: String => key } then [origins.fetch(key, "sentence:#{key}"), nil]
        in { observe: String => path } then ["observe:#{path}", nil]
        in { literal: value } then (words = Literal.stated_by_all(patterns, value) || "unstated"
                                    ["literal:#{words}", words])
        end
      end

      # The sentence a claim step's failure reads as, the same words the
      # TypeScript engine prints.
      #: (Array[Hash[Symbol, untyped]]) -> String
      def broken_message(records) = ClaimLine.broken_claims_message(records)

      #: (Integer) -> String
      def runs_text(runs) = runs == 1 ? "1 run" : "#{runs} runs"

      #: (Hash[Symbol, untyped]) -> String
      def cell_text(cell) = { "pass" => "pass", "not-run" => "·" }.fetch(cell[:outcome]) { "#{cell[:outcome]}@#{cell[:line]}" }

      # A head control or a base cell stands where the criterion's behaviour
      # is absent, so a Then failing there the same way in each proof run
      # proves the criterion tells the behaviour apart.
      #: (Hash[Symbol, untyped]) -> bool
      def proves?(cell)
        absent = cell[:world] == "base" || (cell[:world] != "old" && cell[:role] == "control")
        absent && cell[:outcome] == "fail" && cell[:runs] >= Table.proof_runs
      end

      #: (Hash[Symbol, untyped], String) -> String
      def failed_reason(cell, where)
        case cell[:outcome]
        when "not-run" then "did not run #{where}: #{cell[:reason] || "no execution was recorded"}"
        when "fail" then "a claim broke at line #{cell[:line]} #{where}"
        when "broke" then cell[:reason] ? "#{where}, #{cell[:reason]}" : "stopped at line #{cell[:line]} #{where} before a claim there was judged"
        when "stopped" then "the walk was stopped with nuka step stop after line #{cell[:line]} #{where}, so the steps after it did not run and nothing shows it holds"
        else "its #{runs_text(cell[:runs])} #{where} disagree, the first that did not pass at line #{cell[:line]}"
        end
      end

      #: (Array[String]) -> String
      def listed(parts) = parts.size <= 2 ? parts.join(" and ") : "#{parts[0..-2].to_a.join(", ")}, and #{parts.last}"

      # What changed under an unchanged criterion, or nil when nothing did.
      #: (Hash[Symbol, untyped]) -> String?
      def underneath_change(context)
        changed = { "the mapping" => :mapping_changed, "its tags" => :retagged, "its name or its file" => :renamed }.filter_map { |text, key| text if context[key] }
        changed.empty? ? nil : "#{listed(changed)} changed since the base"
      end

      # The environments a row needs a base cell and an old cell in, from its
      # head cells: none unless every required head cell passed; an
      # unchanged row runs in the old world when something under it
      # changed; a new or changed row runs at the base unless a head
      # control already proves it, or it carries @held.
      #: (Array[Hash[Symbol, untyped]], Hash[Symbol, untyped]?, Array[Hash[Symbol, untyped]]) -> Hash[Symbol, Array[String]]
      def planned_world_cells(head_cells, context, old_roles)
        none = { base: [], old: [] }
        return none unless context

        required = head_cells.select { _1[:role] == "required" }
        return none if required.empty? || required.any? { _1[:outcome] != "pass" }
        if context[:change] == "unchanged"
          return none unless underneath_change(context)

          return { base: [], old: old_roles.select { _1[:role] == "required" }.map { _1[:environment] } }
        end
        return none if !context[:held] && head_cells.any? { proves?(_1) }
        # A Then a judgment decides compares nothing, so a base cell passes
        # whatever the base does and cannot change the verdict.
        return none if !context[:held] && context[:then_judges_no_claim] == "judgment"

        { base: required.map { _1[:environment] }, old: [] }
      end

      #: (Hash[Symbol, untyped]) -> String
      def world_cell_clause(cell)
        where = cell[:world] == "old" ? "in the old world in #{cell[:environment]}" : "at the base in #{cell[:environment]}"
        line = cell[:world] == "old" ? "line #{cell[:line]} of the base's feature file" : "line #{cell[:line]}"
        case cell[:outcome]
        when "not-run" then "it did not run #{where}: #{cell[:reason] || "no execution was recorded"}"
        when "pass" then "it passed #{where}"
        when "broke" then cell[:reason] ? "#{where}, #{cell[:reason]}" : "it stopped at #{line} #{where} before a claim there was judged"
        when "stopped" then "the walk was stopped after #{line} #{where}"
        when "flaky" then "its #{runs_text(cell[:runs])} #{where} disagree, the first that did not pass at #{line}"
        else
          if cell[:world] == "base" && cell[:runs] < Table.proof_runs
            "a claim broke at #{line} #{where} in only #{runs_text(cell[:runs])}, and proof needs #{Table.proof_runs}"
          else
            "a claim broke at #{line} #{where}"
          end
        end
      end

      #: (Array[Hash[Symbol, untyped]]) -> String
      def world_cells_clause(cells)
        template = world_cell_clause(cells.first.merge(environment: "\u0000"))
        same = cells.select { world_cell_clause(_1.merge(environment: "\u0000")) == template }.map { _1[:environment] }
        template.sub("\u0000") { same.join(", ") }
      end

      #: (String, Hash[Symbol, untyped]) -> String
      def control_proof_reason(passed_in, proof)
        "passes in #{passed_in}, and a claim broke at line #{proof[:line]} in #{proof[:environment]}, where its conditions do not hold, in each of #{runs_text(proof[:runs])}"
      end

      # A row's verdict and why, from its cells: red for a required cell that
      # did not pass, or for a row with no required cell; proven when a
      # control fails at a Then the same way in each proof run. Under
      # `--base` (`context`), red too for a new or changed row nothing proves
      # (unproven) and an unchanged row the old world does not pass (moved).
      #: (Array[Hash[Symbol, untyped]], ?Hash[Symbol, untyped]?) -> [String, String]
      def judge_row(cells, context = nil)
        head = cells.select { _1[:world] == "head" }
        required = head.select { _1[:role] == "required" }
        if required.empty?
          return ["failed", "no environment of this run meets its conditions, so every cell is a control and nothing shows that it holds"]
        end

        red = required.reject { _1[:outcome] == "pass" }
        if red.any?
          template = failed_reason(red.first, "in \u0000")
          same = red.select { failed_reason(_1, "in \u0000") == template }.map { _1[:environment] }
          clause = template.sub("\u0000") { same.join(", ") }
          passed = required.select { _1[:outcome] == "pass" }.map { _1[:environment] }
          return ["failed", passed.empty? ? clause : "#{clause}, and passes in #{passed.join(", ")}, where it is required too"]
        end

        passed_in = required.map { _1[:environment] }.join(", ")
        controls = head.select { _1[:role] == "control" }
        proof = controls.find { proves?(_1) }
        unless context
          return ["proven", control_proof_reason(passed_in, proof)] if proof
          return ["held", "passes in #{passed_in}"] if controls.empty?

          return ["held", "passes in #{passed_in}; no control shows a Then failing where its conditions do not hold (#{controls.map { "#{_1[:environment]}: #{cell_text(_1)}" }.join(", ")})"]
        end

        if context[:change] == "unchanged"
          changed = underneath_change(context)
          if changed
            old = cells.select { _1[:world] == "old" }
            moved = old.reject { _1[:outcome] == "pass" }
            return ["moved", "passes in #{passed_in}, but #{changed} and the old world did not run it"] if old.empty?
            return ["moved", "passes in #{passed_in}, but #{changed}, and #{world_cells_clause(moved)}"] if moved.any?
          end
          if proof
            proven = control_proof_reason(passed_in, proof)
            return ["proven", changed ? "#{proven}, and it passed in the old world, where the base's mapping runs head's code" : proven]
          end
          return ["held", "passes in #{passed_in}, and neither it nor the mapping changed since the base"] unless changed

          return ["held", "passes in #{passed_in}, and in the old world, where the base's mapping runs head's code"]
        end

        base = cells.select { _1[:world] == "base" }
        base_proof = base.find { proves?(_1) }
        if base_proof
          proven = "passes in #{passed_in}, and a claim broke at line #{base_proof[:line]} at the base in #{base_proof[:environment]} in each of #{runs_text(base_proof[:runs])}"
          return ["proven", context[:held] ? "#{proven}, so the base does not have this behaviour and @held is not needed" : proven]
        end
        return ["proven", control_proof_reason(passed_in, proof)] if proof

        if context[:held]
          return ["held", "passes in #{passed_in} and at the base, as @held says"] if base.any? && base.all? { _1[:outcome] == "pass" }

          short = base.reject { _1[:outcome] == "pass" }
          clause = short.empty? ? "it did not run at the base" : world_cells_clause(short)
          return ["unproven", "passes in #{passed_in}, and @held says the base has this behaviour, but #{clause}"]
        end
        absent = [*base.map { "base #{_1[:environment]}: #{cell_text(_1)}#{" (#{_1[:reason]})" if _1[:outcome] == "not-run" && _1[:reason]}" },
                  *controls.map { "control #{_1[:environment]}: #{cell_text(_1)}" }]
        # A Then whose claims a reader judges compares nothing, so no world
        # can prove it, and no world can leave it unproven either: the
        # judgment column decides it, and the row is held on what the
        # machine compared, which is everything before that Then.
        if context[:then_judges_no_claim] == "judgment"
          return ["held", "passes in #{passed_in}, and its Then asks for a judgment and compares nothing, so no world can show it failing where its behaviour is absent: " \
                          "its judgment decides it"]
        end
        if context[:then_judges_no_claim]
          then_text = context[:then_judges_no_claim] == "compat" ? "its Then is a compat step, which judges no claim" : "no claim step stands in its Then position"
          return ["unproven", "passes in #{passed_in}, but #{then_text}, so no world can show a Then failing where its behaviour is absent" \
                              "#{absent.empty? ? "" : " (#{absent.join(", ")})"}"]
        end
        if absent.empty?
          return ["unproven", "passes in #{passed_in}, and no world where its behaviour is absent ran it, so nothing shows a Then failing without the change"]
        end

        ["unproven", "passes in #{passed_in}, and nothing shows a Then failing where its behaviour is absent (#{absent.join(", ")})"]
      end

      # The head scenarios by status, and the head cells of the table that
      # did not run, a required one and a control apart: a world whose
      # program did not start runs none of its cells.
      #: (Array[Hash[Symbol, untyped]], ?Array[Hash[Symbol, untyped]]) -> Hash[Symbol, Integer]
      def counts(scenarios, rows = [])
        head = scenarios.reject { _1[:role] == "control" }
        controls = scenarios.select { _1[:role] == "control" }
        not_run = ->(role) { rows.sum { |row| row[:cells].count { _1[:world] == "head" && _1[:role] == role && _1[:outcome] == "not-run" } } }
        { scenarios: head.size, passed: head.count { _1[:status] == "passed" }, failed: head.count { _1[:status] == "failed" },
          stopped: head.count { _1[:status] == "stopped" }, not_run: not_run.("required"), controls: controls.size, controls_not_run: not_run.("control") }
      end

      # The commit HEAD named when the run started, whether the tree had an
      # uncommitted change, and the working tree as one git tree id, written
      # through a copy of the index so the real one is never touched. Null
      # outside a git repository or before the first commit.
      #: (String) -> Hash[Symbol, untyped]?
      def commit(project)
        sha, ok = git(project, "rev-parse", "--verify", "HEAD")
        return nil unless ok

        status, = git(project, "status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).nukadoko")
        { sha: sha, dirty: !status.empty?, working_tree: working_tree(project) }
      end

      #: (String) -> String?
      def working_tree(project)
        index, ok = git(project, "rev-parse", "--git-path", "index")
        return nil unless ok

        Dir.mktmpdir("nukadoko-index-") do |dir|
          copy = File.join(dir, "index")
          real = File.expand_path(index, project)
          FileUtils.cp(real, copy) if File.exist?(real)
          env = { "GIT_INDEX_FILE" => copy }
          # Only the paths that changed are hashed, and --info-only records
          # their ids without writing any file's contents to the object store.
          changed, listed = git(project, "ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard",
                                "--", ".", ":(exclude).nukadoko", env: env, strip: false)
          _, updated = git(project, "update-index", "-z", "--add", "--remove", "--info-only", "--stdin", env: env, input: changed)
          tree, wrote = git(project, "write-tree", "--missing-ok", env: env)
          listed && updated && wrote ? tree : nil
        end
      end

      #: (String, *String, ?env: Hash[String, String], ?input: String, ?strip: bool) -> [String, bool]
      def git(project, *argv, env: {}, input: "", strip: true)
        out, status = Open3.capture2(env, "git", *argv, chdir: project, err: File::NULL, stdin_data: input)
        [strip ? out.strip : out, status.success?]
      rescue SystemCallError
        ["", false]
      end
    end
  end
end
