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
        in String => key then [origins.fetch(key, "sentence:#{key}"), origins.key?(key) ? nil : texts[key]]
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

      def cell_text(cell) = cell[:outcome] == "pass" ? "pass" : "#{cell[:outcome]}@#{cell[:line]}"

      def proves?(cell) = cell[:role] == "control" && cell[:outcome] == "fail" && cell[:runs] >= Table::PROOF_RUNS

      def failed_reason(cell, where)
        case cell[:outcome]
        when "fail" then "a claim broke at line #{cell[:line]} #{where}"
        when "broke" then "stopped at line #{cell[:line]} #{where} before a claim there was judged"
        else "its #{runs_text(cell[:runs])} #{where} disagree, the first that did not pass at line #{cell[:line]}"
        end
      end

      # A row's verdict and why, from its cells: red for a required cell that
      # did not pass, or for a row with no required cell; proven when a
      # control fails at a Then the same way in each proof run.
      def judge_row(cells)
        required = cells.select { _1[:role] == "required" }
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
        controls = cells.select { _1[:role] == "control" }
        proof = controls.find { proves?(_1) }
        if proof
          return ["proven", "passes in #{passed_in}, and a claim broke at line #{proof[:line]} in #{proof[:environment]}, where its conditions do not hold, in each of #{runs_text(proof[:runs])}"]
        end
        return ["held", "passes in #{passed_in}"] if controls.empty?

        ["held", "passes in #{passed_in}; no control shows a Then failing where its conditions do not hold (#{controls.map { "#{_1[:environment]}: #{cell_text(_1)}" }.join(", ")})"]
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
          tree, wrote = git(project, "write-tree", env: env)
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
