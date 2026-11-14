# frozen_string_literal: true

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
      def step_file(record, environment:, world_name:, run_id:, scenario_record_id:, evidence_dir:)
        passed = record[:status] == "passed"
        outcome = if passed then { result: record[:result] || {}, returns_dropped: record[:returns_dropped] }.compact
                  else { error: { message: record[:error], kind: record[:error_kind] } }
                  end
        processes = record[:processes]
        used = (record[:used] || []).map do |entry|
          { step_record_id: File.basename(entry[:record]), step: entry[:step], **(passed ? {} : { result: entry[:result] }) }
        end
        { schema_version: SCHEMA_VERSION, nukadoko: VERSION, step_record_id: record[:step_record_id], step: record[:step], kind: "run",
          args: record[:args] || {}, **(record[:args_origin]&.any? ? { args_origin: record[:args_origin] } : {}),
          **outcome, status: record[:status], environment: environment, world_name: world_name,
          scenario_record_id: scenario_record_id, run_id: run_id, started_at: record[:started_at], finished_at: record[:finished_at],
          evidence: { dir: evidence_dir, screenshots: [], **(record[:scratch] ? { scratch: record[:scratch] } : {}),
                      **(record[:http_file] ? { http: "http.jsonl" } : {}), **(record[:trace] ? { trace: record[:trace] } : {}) },
          observed: { processes: processes&.any? ? processes : nil, http: record[:http_count].to_i.positive? ? record[:http_count] : nil,
                      files: record[:files], unmeasured: [], **(record.key?(:program_log) ? { program_log: record[:program_log] } : {}) },
          mutates: record[:mutates], **(used.any? ? { used: used } : {}), **(record[:calls] ? { calls: record[:calls] } : {}),
          **(record[:actions] ? { actions: record[:actions] } : {}), **(record[:actions_truncated] ? { truncated: { actions: record[:actions_truncated] } } : {}),
          **(record[:fixtures] ? { fixtures: record[:fixtures] } : {}),
          **(record[:claim_records] ? { claims: record[:claim_records], observation: record[:observation] || "observed", **poll_fields(record), **page_fields(record) } : {}) }
      end

      # One comparison, as run.json's steps[].claims[] holds it. `origins`
      # maps an args key to the label of where its value came from, and
      # `texts` to the text the sentence stated it as.
      def claim(declared, judged, origins, texts, observed:, patterns: [])
        actual_key = declared[:actual].to_s
        base = if observed then "observe:#{actual_key}"
               else origins.fetch(actual_key, "sentence:#{actual_key}")
               end
        actual_from = place(base, declared[:view], declared[:at])
        expected_from, expected_text = expected_origin(declared, origins, texts, patterns)
        { actual: judged[:actual], actual_from: actual_from, view: declared[:view], at: declared[:at]&.to_s,
          compare: declared[:compare], expected: judged[:expected], expected_from: expected_from,
          expected_view: declared[:expected_view] }.compact.merge(expected_text: expected_text, outcome: judged[:holds] ? "held" : "broken", measured: nil)
      end

      READING_MAX_BYTES = 1024

      # What a claim step's page had received by its judged reading, and
      # what the page showed right after it. A file is named from the step
      # record's directory, or from the run's when `under` names the step's.
      def page_fields(record, under = nil)
        view = record[:page_view] or return {}
        return view unless under && view[:judged_view]

        pages = view[:judged_view][:pages].map do |page|
          page.merge(%i[screenshot aria].to_h { |key| [key, page[key] && page[key].merge(file: File.join(under, page[key][:file]))] })
        end
        view.merge(judged_view: { pages: pages })
      end

      # How many times a claim step read, and for a polled one each reading
      # and the settled conditions, with the reading the poll stopped on
      # when two settled.
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

      def reading_value(value)
        text = JSON.generate(value)
        text.bytesize <= READING_MAX_BYTES ? { value: value } : { json_start: text.byteslice(0, READING_MAX_BYTES).scrub(""), json_bytes: text.bytesize }
      end

      # Why a poll whose claim broke stopped, on the failure's first line,
      # so a reading that settled is never mistaken for the timeout passing.
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
      def each_claim(declared, observed, args, origins, texts, observed_from:, patterns: [])
        key = declared[:actual].to_s
        actual_from = place(observed_from ? "observe:#{key}" : origins.fetch(key, "sentence:#{key}"), declared[:view], declared[:at])
        each = declared[:each]
        where = each[:where] || []
        declarations = { **(where.empty? ? {} : { where: where.map { item_declaration(_1, args, origins, texts, patterns) } }),
                         claims: each[:claims].map { item_declaration(_1, args, origins, texts, patterns) } }
        base = { actual_from: actual_from, view: declared[:view], at: declared[:at]&.to_s }.compact
        value = begin
          Claims.dig(Claims.view(declared[:view], Claims.read(observed, declared[:actual])), declared[:at])
        rescue StandardError => e
          unread = e
        end
        ended = lambda do |reason, items = 0, results = []|
          base.merge(each: { **declarations, items: items, selected: 0, results: results }, outcome: "broken", reason: reason, measured: nil)
        end
        return ended.("#{actual_from} could not be read: #{unread.message}") if unread
        return ended.("each reads an array, and the value is #{article(json_type(value))}") unless value.is_a?(Array)
        return ended.("the array is empty, and a claim on every item of nothing measures nothing") if value.empty?

        judged = value.each_with_index.map do |item, index|
          at = "#{actual_from}.#{index}"
          where_records = where.map { item_comparison(_1, item, at, args, origins, texts, patterns) }
          next { index: index, selected: false, where: where_records } unless where_records.all? { _1[:outcome] == "held" }

          claims = each[:claims].map { item_comparison(_1, item, at, args, origins, texts, patterns) }
          outcome = claims.any? { _1[:outcome] == "broken" } ? "broken" : "held"
          identity = outcome == "broken" && item.is_a?(Hash) && IDENTITY_FIELDS.lazy.filter_map do |field|
            v = item.transform_keys(&:to_s)[field]
            { field: field, value: v } if v.is_a?(String) || (v.is_a?(Numeric) && v.finite?)
          end.first
          { index: index, selected: true, **(where_records.empty? ? {} : { where: where_records }), outcome: outcome, claims: claims,
            **(identity ? { identity: identity } : {}) }
        end
        selected = judged.count { _1[:selected] }
        rank = ->(entry) { !entry[:selected] ? 2 : entry[:outcome] == "broken" ? 0 : 3 }
        kept = judged.sort_by { [rank.(_1), _1[:index]] }.first(EACH_RESULTS_CAP).sort_by { _1[:index] }
        truncated = judged.size > kept.size ? { results_truncated: judged.size } : {}
        record = base.merge(each: { **declarations, items: value.size, selected: selected, results: kept, **truncated })
        if selected.zero?
          return record.merge(outcome: "broken", reason: "where selected none of the #{value.size} items, and a claim on none of them measures nothing", measured: nil)
        end

        record.merge(outcome: judged.any? { _1[:selected] && _1[:outcome] == "broken" } ? "broken" : "held", measured: nil)
      end

      def item_declaration(entry, args, origins, texts, patterns)
        expected_from, expected_text = expected_origin(entry, origins, texts, patterns)
        expected = begin
          { expected: Claims.expected_value(entry, args) }
        rescue StandardError
          {}
        end
        { actual: entry[:actual]&.to_s, view: entry[:view], at: entry[:at]&.to_s, count: entry[:count] }.compact
          .merge(compare: entry[:compare], **expected, expected_from: expected_from, **(entry[:expected_view] ? { expected_view: entry[:expected_view] } : {}),
                 expected_text: expected_text)
      end

      def item_comparison(entry, item, at, args, origins, texts, patterns)
        judged = Claims.judge_one(entry, item, args)
        expected_from, expected_text = expected_origin(entry, origins, texts, patterns)
        { actual: judged[:actual], actual_from: place(entry[:actual] ? "#{at}.#{entry[:actual]}" : at, entry[:view], entry[:at]),
          view: entry[:view], at: entry[:at]&.to_s }.compact
          .merge(compare: entry[:compare], expected: judged[:expected], expected_from: expected_from,
                 **(entry[:expected_view] ? { expected_view: entry[:expected_view] } : {}), expected_text: expected_text,
                 outcome: judged[:holds] ? "held" : "broken")
      end

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

      def article(type) = %w[array object].include?(type) ? "an #{type}" : "a #{type}"

      # A claim whose observe raised: where each side would come from, and no value.
      def unobserved_claim(declared, origins, texts, patterns: [])
        expected_from, expected_text = expected_origin(declared, origins, texts, patterns)
        { actual_from: place("observe:#{declared[:actual]}", declared[:view], declared[:at]), view: declared[:view], at: declared[:at]&.to_s,
          compare: declared[:compare], expected_from: expected_from, expected_view: declared[:expected_view], expected_text: expected_text,
          outcome: "unobserved" }.compact.merge(measured: nil)
      end

      # Where a side of a claim reads: its origin, read through its view,
      # then walked to its path, as the TypeScript engine labels it.
      def place(base, view, at)
        label = view ? "#{base} as #{view}" : base
        return label unless at

        "#{label}#{view ? " at " : "."}#{at}"
      end

      # A literal is named by the pattern words that state it, so the label
      # reads as the sentence did.
      def expected_origin(declared, origins, texts, patterns)
        case declared[:expected]
        in String => key then [place(origins.fetch(key, "sentence:#{key}"), declared[:expected_view], nil), texts[key]]
        in { from: String => key } then [origins.fetch(key, "sentence:#{key}"), nil]
        in { literal: value } then (words = Literal.stated_by_all(patterns, value) || "unstated"
                                    ["literal:#{words}", words])
        end
      end

      # The sentence a claim step's failure reads as, the same words the
      # TypeScript engine prints.
      def broken_message(records) = ClaimLine.broken_claims_message(records)

      def runs_text(runs) = runs == 1 ? "1 run" : "#{runs} runs"

      def cell_text(cell) = { "pass" => "pass", "not-run" => "·" }.fetch(cell[:outcome]) { "#{cell[:outcome]}@#{cell[:line]}" }

      # A head control or a base cell stands where the criterion's behaviour
      # is absent, so a Then failing there the same way in each proof run
      # proves the criterion tells the behaviour apart.
      def proves?(cell)
        absent = cell[:world] == "base" || (cell[:world] != "old" && cell[:role] == "control")
        absent && cell[:outcome] == "fail" && cell[:runs] >= Table.proof_runs
      end

      def failed_reason(cell, where)
        case cell[:outcome]
        when "not-run" then "did not run #{where}: #{cell[:reason] || "no execution was recorded"}"
        when "fail" then "a claim broke at line #{cell[:line]} #{where}"
        when "broke" then "stopped at line #{cell[:line]} #{where} before a claim there was judged"
        else "its #{runs_text(cell[:runs])} #{where} disagree, the first that did not pass at line #{cell[:line]}"
        end
      end

      def listed(parts) = parts.size <= 2 ? parts.join(" and ") : "#{parts[0..-2].join(", ")}, and #{parts.last}"

      # What changed under an unchanged criterion, or nil when nothing did.
      def underneath_change(context)
        changed = [*("the mapping" if context[:mapping_changed]), *("its tags" if context[:retagged]), *("its name or its file" if context[:renamed])]
        changed.empty? ? nil : "#{listed(changed)} changed since the base"
      end

      # The environments a row needs a base cell and an old cell in, from its
      # head cells: none unless every required head cell passed; an
      # unchanged row runs in the old world when something under it
      # changed; a new or changed row runs at the base unless a head
      # control already proves it, or it carries @held.
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

        { base: required.map { _1[:environment] }, old: [] }
      end

      def world_cell_clause(cell)
        where = cell[:world] == "old" ? "in the old world in #{cell[:environment]}" : "at the base in #{cell[:environment]}"
        line = cell[:world] == "old" ? "line #{cell[:line]} of the base's feature file" : "line #{cell[:line]}"
        case cell[:outcome]
        when "not-run" then "it did not run #{where}: #{cell[:reason] || "no execution was recorded"}"
        when "pass" then "it passed #{where}"
        when "broke" then "it stopped at #{line} #{where} before a claim there was judged"
        when "flaky" then "its #{runs_text(cell[:runs])} #{where} disagree, the first that did not pass at #{line}"
        else
          if cell[:world] == "base" && cell[:runs] < Table.proof_runs
            "a claim broke at #{line} #{where} in only #{runs_text(cell[:runs])}, and proof needs #{Table.proof_runs}"
          else
            "a claim broke at #{line} #{where}"
          end
        end
      end

      def world_cells_clause(cells)
        template = world_cell_clause(cells.first.merge(environment: "\u0000"))
        same = cells.select { world_cell_clause(_1.merge(environment: "\u0000")) == template }.map { _1[:environment] }
        template.sub("\u0000") { same.join(", ") }
      end

      def control_proof_reason(passed_in, proof)
        "passes in #{passed_in}, and a claim broke at line #{proof[:line]} in #{proof[:environment]}, where its conditions do not hold, in each of #{runs_text(proof[:runs])}"
      end

      # A row's verdict and why, from its cells: red for a required cell that
      # did not pass, or for a row with no required cell; proven when a
      # control fails at a Then the same way in each proof run. Under
      # `--base` (`context`), red too for a new or changed row nothing proves
      # (unproven) and an unchanged row the old world does not pass (moved).
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
        if context[:then_judges_no_claim]
          return ["unproven", "passes in #{passed_in}, but no claim step stands in its Then position, so no world can show a Then failing where its behaviour is absent" \
                              "#{absent.empty? ? "" : " (#{absent.join(", ")})"}"]
        end
        if absent.empty?
          return ["unproven", "passes in #{passed_in}, and no world where its behaviour is absent ran it, so nothing shows a Then failing without the change"]
        end

        ["unproven", "passes in #{passed_in}, and nothing shows a Then failing where its behaviour is absent (#{absent.join(", ")})"]
      end

      def counts(scenarios)
        head = scenarios.reject { _1[:role] == "control" }
        controls = scenarios.select { _1[:role] == "control" }
        { scenarios: head.size, passed: head.count { _1[:status] == "passed" }, failed: head.count { _1[:status] == "failed" },
          stopped: 0, not_run: 0, controls: controls.size, controls_not_run: 0 }
      end

      # The commit HEAD named when the run started, whether the tree had an
      # uncommitted change, and the working tree as one git tree id, written
      # through a copy of the index so the real one is never touched. Null
      # outside a git repository or before the first commit.
      def commit(project)
        sha, ok = git(project, "rev-parse", "--verify", "HEAD")
        return nil unless ok

        status, = git(project, "status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).nukadoko")
        { sha: sha, dirty: !status.empty?, working_tree: working_tree(project) }
      end

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

      def git(project, *argv, env: {}, input: "", strip: true)
        out, status = Open3.capture2(env, "git", *argv, chdir: project, err: File::NULL, stdin_data: input)
        [strip ? out.strip : out, status.success?]
      rescue SystemCallError
        ["", false]
      end
    end
  end
end
