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

      # One comparison, as run.json's steps[].claims[] holds it. `origins`
      # maps an args key to the label of where its value came from, and
      # `texts` to the text the sentence stated it as.
      def claim(declared, judged, origins, texts, observed:)
        actual_key = declared[:actual].to_s
        actual_from = if observed then "observe:#{actual_key}"
                      else origins.fetch(actual_key, "sentence:#{actual_key}")
                      end
        actual_from = "#{actual_from}.#{declared[:at]}" if declared[:at]
        expected_from, expected_text = expected_origin(declared, origins, texts)
        { actual: judged[:actual], actual_from: actual_from, view: declared[:view], at: declared[:at]&.to_s,
          compare: declared[:compare], expected: judged[:expected], expected_from: expected_from,
          expected_view: declared[:expected_view], expected_text: expected_text,
          outcome: judged[:holds] ? "held" : "broken", measured: nil }.compact.merge(measured: nil)
      end

      def expected_origin(declared, origins, texts)
        case declared[:expected]
        in String => key then [origins.fetch(key, "sentence:#{key}"), texts[key]]
        in { from: String => key } then [origins.fetch(key, "sentence:#{key}"), nil]
        in { literal: value } then ["literal:#{JSON.generate(value)}", JSON.generate(value)]
        end
      end

      # The sentence a broken claim reads as, the same words the TypeScript
      # engine prints.
      def broken_message(claim)
        view = claim[:view] ? " as #{claim[:view]}" : ""
        "claim broken: #{JSON.generate(claim[:actual])} (#{claim[:actual_from]}#{view}) #{claim[:compare]} #{JSON.generate(claim[:expected])} (#{claim[:expected_from]})"
      end

      def runs_text(runs) = runs == 1 ? "1 run" : "#{runs} runs"

      def cell_text(cell) = { "pass" => "pass", "not-run" => "·" }.fetch(cell[:outcome]) { "#{cell[:outcome]}@#{cell[:line]}" }

      # A head control or a base cell stands where the criterion's behaviour
      # is absent, so a Then failing there the same way in each proof run
      # proves the criterion tells the behaviour apart.
      def proves?(cell)
        absent = cell[:world] == "base" || (cell[:world] != "old" && cell[:role] == "control")
        absent && cell[:outcome] == "fail" && cell[:runs] >= Table::PROOF_RUNS
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
          if cell[:world] == "base" && cell[:runs] < Table::PROOF_RUNS
            "a claim broke at #{line} #{where} in only #{runs_text(cell[:runs])}, and proof needs #{Table::PROOF_RUNS}"
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
