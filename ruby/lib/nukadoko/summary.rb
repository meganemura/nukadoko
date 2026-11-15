# frozen_string_literal: true
# rbs_inline: enabled

require "json"
require "time"

# summary.md: the run as a person reads it, rendered from run.json alone,
# in the TypeScript engine's words, so a summary never says something
# run.json does not and `nuka report` renders the same file again from a
# run.json copied off another machine. The sections this engine has no
# field for yet (removed criteria, paths, flags, routes, judgments) are
# left out, as the TypeScript engine leaves them out of a run without
# them.
module Nukadoko
  module Engine
    module Summary
      MARKER = "<!-- nukadoko:run -->"
      # A failed scenario is its cell, and a row with no required cell is
      # its reason line, so the findings list leaves those out.
      TABLE_CODES = %w[scenario-failed walk-stopped criterion-without-required-cell].freeze
      RED = %w[failed unproven moved].freeze
      VALUE_TEXT_LIMIT = 120
      STDOUT_JSON_LIMIT = 200
      ANSI = /\e\[[0-9;]*[A-Za-z]/
      THROW_LOCATION = %r{\A(?:(.*?): )?(?:node:|file://|/|[A-Za-z]:[\\/]).*:\d+\z}
      CARETS = /\A\s*\^+\s*\z/
      CLAIMS_LEAD = "Each line is one claim of a Then: the actual value and where it came from, how it was compared, " \
                    "the expected value and where it came from, whether it held, and the recorded channel that holds the actual value " \
                    "(`measured: none` when no channel does, or when another channel holds the same number). " \
                    "An expected value an earlier step returned or `observe` read gets the same, as `expected measured`."
      CONTROL_NOTE = " An entry marked `control` is a control's: a claim it broke is evidence that the scenario tells the behaviour apart, not a failure."
      LIMIT_KINDS = %w[left-out check-skipped control-not-proving no-claim judgment unmeasured after-record unrecorded-log unrecorded-events].freeze
      LIMIT_HEADINGS = {
        "left-out" => ["Criteria not run"],
        "check-skipped" => ["Static check skipped"],
        "control-not-proving" => ["Held, and no control failed at a Then",
                                  "a control of each criterion below ran where its conditions do not hold, and none failed at a Then, so nothing shows its Then notices the behaviour is absent"],
        "no-claim" => ["Scenarios with no claim", "in each scenario below, no claim on a Then line was judged (held, broken, or unjudged)"],
        "judgment" => ["Held on a judgment",
                       "each criterion below asks a reader to judge a value its Then read, and a committed judgment cites that value; nukadoko checks the citation, never the judgment"],
        "unmeasured" => ["Unmeasured actions", "each step below did something nukadoko records but cannot measure, so its record has no evidence of what that action did"]
      }.freeze

      module_function

      def render(doc)
        lines = [MARKER, *title(doc), *table(doc), *reasons(doc), *limits_section(doc), *condition(doc),
                 *removed(doc), *claims(doc), *findings(doc), *rerun(doc)]
        "#{lines.join("\n")}\n"
      end

      # Text outside a code span: `\` doubled first, so the `\` before a
      # `|` survives both the table parser and the inline one, and `<`
      # never opens a tag.
      def cell_text(text) = text.to_s.gsub("\\", "\\\\\\\\").gsub("|", "\\|").gsub("<", "&lt;")

      # A code span longer than any backtick run inside it.
      def code_span(text)
        text = text.to_s
        fence = "`" * ((text.scan(/`+/).map(&:size).max || 0) + 1)
        padded = text.start_with?("`") || text.end_with?("`") ? " #{text} " : text
        "#{fence}#{padded}#{fence}"
      end

      def cell_code(text) = code_span(text).gsub("|", "\\|")

      def count_of(count, one, many) = "#{count} #{count == 1 ? one : many}"

      def duration(ms)
        total = (([ms, 0].max) / 1000.0).round
        hours, rest = total.divmod(3600)
        minutes, seconds = rest.divmod(60)
        parts = []
        parts << "#{hours}h" if hours.positive?
        parts << "#{minutes}m" if hours.positive? || minutes.positive?
        parts << "#{seconds}s"
        parts.join(" ")
      end

      def value_text(value)
        text = JSON.generate(value)
        text.length > VALUE_TEXT_LIMIT ? "#{text[0, VALUE_TEXT_LIMIT]}..." : text
      end

      # The first line with text in it; a Node throw location with its
      # source line and carets is skipped, and a line that ends in a colon
      # takes the next line after it.
      def first_visible_line(text, join = true)
        lines = text.to_s.gsub(ANSI, "").split(/\r\n?|[\n\u2028\u2029]/)
        first = lines.index { !_1.strip.empty? }
        return nil unless first

        line = lines[first].strip
        location = THROW_LOCATION.match(line)
        if location && first + 2 < lines.size && CARETS.match?(lines[first + 2])
          error = first_visible_line(lines[(first + 3)..].join("\n"), join)
          return location[1] ? "#{location[1]}: #{error}" : error if error
        end
        if join && line.end_with?(":")
          after = first_visible_line(lines[(first + 1)..].join("\n"), false)
          return "#{line} #{after}" if after
        end
        line
      end

      def first_error_line(message) = first_visible_line(message) || "(no message)"

      def cell_word(cell)
        case cell[:outcome]
        when "not-run" then "·"
        when "pass" then "pass"
        else "#{cell[:outcome]}@#{cell[:line]}"
        end
      end

      def head_scenarios(doc) = doc[:scenarios].reject { _1[:world] }

      def conditions_text(conditions)
        return "none" if conditions.empty?

        conditions.map { |name, value| "#{name}: #{value.is_a?(String) ? JSON.generate(value) : value}" }.join(", ")
      end

      def title(doc)
        rows = doc[:table][:rows]
        count = ->(verdict) { rows.count { _1[:verdict] == verdict } }
        criteria = count_of(rows.size, "criterion", "criteria")
        envs = doc[:environments].size
        parts = [envs > 1 ? "#{criteria} in #{envs} environments" : criteria, "#{count.("held")} held"]
        %w[proven removed failed unproven moved].each { parts << "#{count.(_1)} #{_1}" if count.(_1).positive? }
        # Judgments are counted apart from the verdicts they stand beside, so
        # a reader never adds a judged row to the held ones it is counted in.
        Judgments::TITLE_ORDER.each do |state|
          judged = rows.count { _1.dig(:judgment, :state) == state }
          parts << "#{judged} #{judged == 1 ? "judgment" : "judgments"} #{state}" if judged.positive?
        end
        lines = ["# nukadoko run #{doc[:verdict]}: #{parts.join(", ")}"]
        explained = rows.any? do |row|
          next true if %w[unproven moved].include?(row[:verdict])
          next true if row[:judgment] && row[:judgment][:state] != "judged"
          next false unless row[:verdict] == "failed"

          required = row[:cells].select { _1[:role] == "required" }
          required.empty? || required.any? { !%w[pass not-run].include?(_1[:outcome]) }
        end
        if doc[:verdict] == "failed" && !explained
          lines.push("", "No scenario that ran failed, but the run did: a BeforeAll or AfterAll hook, or a worker that wrote no scenario, " \
                         "failed outside every scenario. The findings below name it.")
        end
        lines
      end

      def table_cell(cell)
        notes = [*("control" if cell[:role] == "control"), *("#{cell[:runs]} runs" if cell[:runs].to_i > 1)]
        "#{cell_word(cell)}#{notes.empty? ? "" : " (#{notes.join(", ")})"}"
      end

      def table(doc)
        worlds = doc[:table][:worlds]
        rows = doc[:table][:rows]
        base = doc[:table][:base]
        return [] if rows.empty?

        heading = lambda do |column|
          declared = (doc[:environments].find { _1[:name] == column[:environment] }&.dig(:conditions) if column[:world] == "head")
          "#{column[:world]} #{column[:environment]}#{declared ? " (#{conditions_text(declared)})" : ""}"
        end
        change = lambda do |row|
          next [] unless base

          renamed = row[:renamed_from] ? ", renamed from #{cell_code(row[:renamed_from][:feature])} #{cell_text(row[:renamed_from][:name])}" : ""
          ["#{row[:change]}#{renamed}#{", retagged" if row[:retagged]}"]
        end
        seen = seen_column(doc)
        # The judgment column only when a row has one.
        judged = rows.any? { _1[:judgment] }
        [
          *base_line(doc),
          "",
          "| verdict | #{"judgment | " if judged}criterion | #{"change | " if base}#{worlds.map { cell_text(heading.(_1)) }.join(" | ")}#{" | seen" if seen} |",
          "| --- | #{"--- | " if judged}--- | #{"--- | " if base}#{worlds.map { "---" }.join(" | ")}#{" | ---" if seen} |",
          *rows.map do |row|
            written = [*row[:conditions], *row[:expects]]
            tags = written.empty? ? "" : " #{written.map { cell_code(_1) }.join(" ")}"
            cells = worlds.map do |column|
              cell = row[:cells].find { _1[:world] == column[:world] && _1[:environment] == column[:environment] }
              cell ? table_cell(cell) : ""
            end
            judgment = judged ? [row.dig(:judgment, :state).to_s] : []
            "| #{[row[:verdict], *judgment, "#{cell_code("#{row[:feature]}:#{row[:line]}")} #{cell_text(row[:name])}#{tags}", *change.(row), *cells, *(seen ? [seen.(row)] : [])].join(" | ")} |"
          end
        ]
      end

      # The line above the table under `--base`: what the run compared with,
      # how many criteria changed, and whether the mapping changed and what
      # in it, since an unchanged criterion over a changed mapping is what
      # the old world was run for.
      def base_line(doc)
        base = doc[:table][:base] or return []
        rows = doc[:table][:rows]
        count = ->(change) { rows.count { _1[:change] == change } }
        changes = "#{count.("unchanged")} unchanged, #{count.("changed")} changed, #{count.("new")} new, #{count.("removed")} removed"
        mapping = doc[:table][:mapping_changes]
        parts = []
        if mapping
          parts << "#{mapping[:files].size == 1 ? "file" : "files"} #{mapping[:files].map { cell_code(_1) }.join(", ")}" if mapping[:files].any?
          parts << "the config's mapping part" if mapping[:config]
          parts << "the conditions of #{mapping[:conditions].map { cell_code(_1) }.join(", ")}" if mapping[:conditions].any?
          parts << "defaultEnvironments" if mapping[:default_environments]
        end
        unchanged = rows.select { _1[:change] == "unchanged" && _1[:verdict] != "failed" }
        ran_old = unchanged.count do |row|
          old = row[:cells].select { _1[:world] == "old" }
          old.any? && old.none? { _1[:outcome] == "not-run" }
        end
        old_ran = if ran_old == unchanged.size then "so the old world ran each unchanged criterion under the base's steps."
                  else "so each unchanged criterion needed the old world, but it ran #{ran_old.zero? ? "none of them" : "only #{ran_old} of the #{unchanged.size}"}; each moved row says why."
                  end
        mapping_line = if doc[:table][:mapping_changed]
                         "The mapping changed (#{parts.empty? ? "the base's could not be read" : parts.join("; ")}), #{old_ran}"
                       else "The mapping did not change, so no unchanged criterion needed the old world."
                       end
        compared = base[:commit].start_with?(base[:ref]) ? cell_code(base[:ref]) : "#{cell_code(base[:ref])} (`#{base[:commit][0, 7]}`)"
        # Judgments are not mapping, so the line names them apart: a reviewer
        # approves what a judge said beside what the steps do.
        judgments = doc[:table][:judgments_changed] || []
        judgment_line = if judgments.empty? then ""
                        else " #{judgments.size == 1 ? "A judgment file" : "Judgment files"} changed since the base: #{judgments.map { cell_code(_1) }.join(", ")}."
                        end
        ["", "Compared with #{compared}: #{changes}. #{mapping_line}#{judgment_line}"]
      end

      # Each criterion the base holds and head does not, with its sentences
      # at the base, so a reader approving the change sees what it drops.
      def removed(doc)
        rows = doc[:table][:rows].select { _1[:verdict] == "removed" }
        return [] if rows.empty?

        lines = ["", "## Removed criteria", "", "Each criterion below is in the base and not in head, quoted as the base has it."]
        rows.each do |row|
          text = row[:lines] || []
          fence = "`" * ([2, *text.flat_map { _1.scan(/`+/).map(&:size) }].max + 1)
          lines.push("", "### #{cell_code("#{row[:feature]}:#{row[:line]}")} #{cell_text(row[:name])}", "", "#{fence}gherkin", *text, fence)
        end
        lines
      end

      # A capture taken at least this long after its reading says so beside
      # its link: a page that changes on a timer of a few hundred
      # milliseconds can show another state by then.
      LATE_VIEW_MS = 100

      # Where a Then's judged moment can be seen: each open page's view
      # right after the reading its claims were judged on, its screenshot
      # before its ARIA snapshot, or, for a Then that read no page, the
      # requests its own step sent. Each link is [label, href, after_ms].
      def seen_links(step)
        pages = step.dig(:judged_view, :pages) || []
        links = pages.flat_map do |page|
          name = pages.size == 1 ? "page" : "page #{page[:page]}#{page[:as].nil? ? "" : " of #{page[:as]}"}"
          [*(page[:screenshot] ? [[name, page[:screenshot][:file], page[:screenshot][:after_reading_ms]]] : []),
           *(page[:aria] ? [["#{name} ARIA", page[:aria][:file], page[:aria][:after_reading_ms]]] : [])]
        end
        # A Then that read a page is linked to its view or to nothing: the
        # requests its pages sent during the step are not what it read.
        return links if step[:judged_view] || step[:pages]

        http = step.dig(:observed, :http)
        return [] unless step[:record] && http.is_a?(Integer) && http.positive?

        [["responses", "#{step[:record].sub(%r{/+\z}, "")}/http.jsonl"]]
      end

      def markdown_link(label, href)
        text = label.gsub(/[\r\n]/, " ").gsub(/[\\\[\]]/) { "\\#{_1}" }
        return "#{text} `#{href.gsub(/[\r\n]/, " ").tr("`", "'")}`" if href.match?(/[<>\n\r]/)

        "[#{text}](<#{href}>)"
      end

      def seen_text(links) = links.map { |label, href, after| "#{markdown_link(label, href)}#{after && after >= LATE_VIEW_MS ? " (taken #{after} ms after the reading)" : ""}" }.join(", ")

      def seen_column(doc)
        chosen = {}
        head_scenarios(doc).each do |scenario|
          key = [scenario[:feature], scenario[:line]]
          held = chosen[key]
          chosen[key] = scenario if held.nil? || (held[:status] == "passed" && scenario[:status] != "passed")
        end
        links_of = lambda do |scenario|
          scenario[:steps].filter_map do |step|
            next unless step[:claims]

            label, href = seen_links(step).first
            markdown_link((step[:line] || scenario[:line]).to_s, href).gsub("|", "\\|") if href
          end
        end
        return nil if chosen.values.none? { links_of.(_1).any? }

        ->(row) { (scenario = chosen[[row[:feature], row[:line]]]) ? links_of.(scenario).join(" ") : "" }
      end

      def reasons(doc)
        red = doc[:table][:rows].select { RED.include?(_1[:verdict]) }
        # A row the judgments leave red says why on a line of its own, before
        # the verdicts' reasons: its verdict may be green.
        open = doc[:table][:rows].select { _1[:judgment] && _1[:judgment][:state] != "judged" }
        return [] if red.empty? && open.empty?

        lines = [""]
        open.each do |row|
          lines << "- #{code_span("#{row[:feature]}:#{row[:line]}")} #{cell_text(row[:name])}: judgment #{row[:judgment][:state]}: #{cell_text(row[:judgment][:reason])}"
        end
        red.each do |row|
          lines << "- #{code_span("#{row[:feature]}:#{row[:line]}")} #{cell_text(row[:name])}: #{cell_text(row[:reason])}"
          world = { "moved" => "old", "unproven" => "base" }.fetch(row[:verdict], "head")
          cell = row[:cells].find { _1[:world] == world && _1[:role] == "required" && !%w[pass not-run].include?(_1[:outcome]) }
          next unless cell

          execution = doc[:scenarios].find do |scenario|
            at = scenario[:row] || { feature: scenario[:feature], line: scenario[:line] }
            at[:feature] == row[:feature] && at[:line] == row[:line] && (scenario[:world] || "head") == world &&
              scenario[:environment] == cell[:environment] && scenario[:status] != "passed"
          end
          failure = execution && describe_failure(execution)
          lines << "  - #{world == "head" ? "" : "#{world}: "}#{failure}" if failure
        end
        lines
      end

      # Where an execution stopped: the step, the error's first line, the
      # producers that exited nonzero, the last command that did, the
      # record, and where the Then can be seen.
      def describe_failure(scenario)
        step = scenario[:steps].find { !%w[passed skipped].include?(_1[:status]) }
        return nil unless step

        parts = ["#{cell_text("step \"#{step[:text]}\"")}: #{code_span(first_error_line(step.dig(:error, :message)))}"]
        exited_producers(step[:used]).each do |name, code, output|
          parts << "used #{cell_text(name)} exit #{code}: #{code_span(output)}"
        end
        command = (step.dig(:observed, :processes) || []).reverse.find { _1[:exit_code] != 0 }
        parts << "ran #{code_span(command[:command].join(" "))}" if command
        parts << "record #{code_span(step[:record])}" if step[:record]
        seen = step[:claims] ? seen_text(seen_links(step)) : ""
        parts << "seen #{seen}" unless seen.empty?
        parts.join("; ")
      end

      def exited_producers(used)
        (used || []).filter_map do |entry|
          result = entry[:result]
          next unless result.is_a?(Hash)

          code, stderr, stdout = result.values_at(:exitCode, :stderr, :stdout)
          next unless code.is_a?(Integer) && code != 0 && stderr.is_a?(String)

          from_stdout = stdout.is_a?(String) ? stdout_line(stdout) : nil
          [entry[:step], code, first_visible_line(stderr) || (from_stdout ? "stdout: #{from_stdout}" : "(no output)")]
        end
      end

      def stdout_line(stdout)
        text = stdout.gsub(ANSI, "").strip
        return nil if text.empty?

        compact = (JSON.generate(JSON.parse(text)).gsub("\u2028", "\\u2028").gsub("\u2029", "\\u2029") rescue nil) if text.start_with?("{", "[")
        return first_visible_line(text) unless compact

        compact.length > STDOUT_JSON_LIMIT ? "#{compact[0, STDOUT_JSON_LIMIT]}..." : compact
      end

      # The gaps a green verdict does not cover, computed again from
      # run.json's other fields, never read from a stored list.
      def limits(doc)
        head = head_scenarios(doc)
        rows = doc[:table][:rows]
        list = []
        left_out = doc[:table][:left_out].to_i
        if left_out.positive?
          list << { kind: "left-out", fix: "run again with `--env` naming an environment that meets their conditions",
                    detail: left_out == 1 ? "1 criterion not run: its conditions hold in no selected environment" : "#{left_out} criteria not run: their conditions hold in no selected environment" }
        end
        if doc[:check] == "skipped"
          list << { kind: "check-skipped", detail: "the run started with `nuka run --no-check`, so no finding of `nuka check` held it back", do: "nuka check" }
        end
        red = rows.select { RED.include?(_1[:verdict]) }.map { [_1[:feature], _1[:line]] }
        unjudged = head.select { _1[:role] != "control" && _1[:judged_by] && _1[:judged_by] != "judgment" && !red.include?([_1[:feature], _1[:line]]) }
        places = unjudged.map { [_1[:feature], _1[:line]] }
        # A row a judgment decides compares nothing in its Then, so no
        # control of it could fail there: its entry is the judgment's.
        judged_rows = rows.select { _1[:judgment] }.map { [_1[:feature], _1[:line]] }
        rows.each do |row|
          next if row[:verdict] != "held" || places.include?([row[:feature], row[:line]]) || judged_rows.include?([row[:feature], row[:line]])

          limit = control_limit(row, head)
          list << limit if limit
        end
        by_place = ->(a, b) { [a[:feature].to_s, a[:line].to_i] <=> [b[:feature].to_s, b[:line].to_i] }
        list.concat(unjudged.uniq { [_1[:feature], _1[:line]] }.map do |scenario|
          { kind: "no-claim", feature: scenario[:feature], line: scenario[:line], text: scenario[:scenario],
            detail: "no claim on a Then line was judged in it", fix: "end the scenario with a Then whose step declares claims" }
        end.sort(&by_place))
        list.concat(judgment_limits(rows))
        list.sort_by.with_index { |limit, index| [LIMIT_KINDS.index(limit[:kind]), index] }
      end

      # One entry per row a judgment holds green: nukadoko checked that the
      # value is the one judged, and nothing of the judgment itself. A value
      # judged as an ARIA snapshot names what that leaves out: a change only
      # to how the page looks keeps the snapshot, and so the judgment.
      def judgment_limits(rows)
        rows.filter_map do |row|
          judgment = row[:judgment]
          next unless judgment && judgment[:state] == "judged"

          by = judgment[:reads].map { _1.dig(:judgment, :by) || "" }.uniq.map { code_span(_1) }.join(", ")
          aria = judgment[:reads].any? { _1[:measured] == "aria-snapshot" } ? "; it is bound to the ARIA snapshot, so a change only to how the page looks keeps it current" : ""
          { kind: "judgment", feature: row[:feature], line: row[:line], text: row[:name],
            detail: "stands on a judgment by #{by}: nukadoko checked that the value is the one judged, not the judgment#{aria}" }
        end
      end

      def control_limit(row, head)
        controls = row[:cells].select { _1[:world] == "head" && _1[:role] == "control" }
        return nil if controls.empty?

        outcomes = controls.map { _1[:outcome] }
        fix = if outcomes.include?("pass") then "make the Then check what its condition switches, or check that the control's environment switches it"
              elsif outcomes.include?("broke") then "make the steps before the Then run where its conditions do not hold, so the Then is what fails there"
              end
        stopped = head.find do |scenario|
          scenario[:feature] == row[:feature] && scenario[:line] == row[:line] && scenario[:role] == "control" &&
            scenario[:status] != "passed" && controls.any? { _1[:environment] == scenario[:environment] }
        end
        record = stopped && stopped[:steps].find { !%w[passed skipped].include?(_1[:status]) }&.dig(:record)
        { kind: "control-not-proving", feature: row[:feature], line: row[:line], text: row[:name],
          detail: "no control failed at a Then where its conditions do not hold (#{controls.map { "#{_1[:environment]}: #{cell_word(_1)}" }.join(", ")})",
          record: record, fix: fix }.compact
      end

      def closer_text(limit) = [*("do: #{code_span(limit[:do])}" if limit[:do]), *("fix: #{limit[:fix]}" if limit[:fix])].join("; ")

      def limit_place(limit, named)
        return "" unless limit[:feature]

        environment = named && limit[:environment] ? " (#{cell_text(limit[:environment])})" : ""
        "#{code_span("#{limit[:feature]}:#{limit[:line]}")}#{limit[:text] ? " #{cell_text(limit[:text])}" : ""}#{environment}"
      end

      def limits_section(doc)
        list = limits(doc)
        return [] if list.empty?

        named = doc[:environments].size > 1
        lines = ["", "## What this run does not show", "",
                 "Each item below is something the verdicts above do not cover, listed under its kind in run.json's `limits`.", ""]
        tail = ->(text) { text.empty? ? "" : "; #{text}" }
        LIMIT_KINDS.each do |kind|
          entries = list.select { _1[:kind] == kind }
          next if entries.empty?

          name, lead = LIMIT_HEADINGS.fetch(kind)
          closers = entries.map { closer_text(_1) }.uniq
          shared = entries.size > 1 && closers.size == 1 ? closers.first : ""
          only = entries.first
          if entries.size == 1 && limit_place(only, named).empty?
            lines << "- **#{name}** (`#{kind}`): #{only[:detail]}#{tail.(closer_text(only))}"
            next
          end
          lines << "- **#{name}** (`#{kind}`, #{entries.size})#{lead ? ": #{lead}" : ""}#{tail.(shared)}"
          entries.each do |limit|
            record = limit[:record] ? "; record #{code_span(limit[:record])}" : ""
            lines << "  - #{limit_place(limit, named)}: #{limit[:detail]}#{record}#{shared.empty? ? tail.(closer_text(limit)) : ""}"
          end
        end
        lines
      end

      def tag_flags(expressions) = code_span(expressions.map { "--tag #{JSON.generate(_1)}" }.join(" "))

      def condition(doc)
        commit = doc[:commit]
        commit_line = if commit.nil? then "- commit: unknown (no git state was readable when the run started)"
                      else "- commit: `#{commit[:sha][0, 7]}`#{" with uncommitted changes" if commit[:dirty]}"
                      end
        environments = doc[:environments].map do |environment|
          at = environment[:base_url] ? " at #{environment[:base_url]}" : ""
          notes = [*("conditions #{conditions_text(environment[:conditions])}" if environment[:conditions]),
                   *("target version #{environment[:target_version]}" if environment[:target_version])]
          "- environment: #{environment[:name]}#{at}#{notes.empty? ? "" : " (#{notes.join(", ")})"}"
        end
        tagged = doc[:tag_selection]
        selection = if doc[:selection] == "full"
                      tagged ? "- selection: full (every scenario of the targeted files meets #{tag_flags(tagged[:expressions])})" : "- selection: full"
                    elsif tagged
                      "- selection: partial (#{tag_flags(tagged[:expressions])} left out #{count_of(tagged[:left_out], "scenario", "scenarios")} of the targeted files)"
                    else "- selection: partial (a line target left out other scenarios of its file)"
                    end
        proof = doc[:table][:proof_runs]
        proof_line = if proof == Table::PROOF_RUNS then []
                     else ["- proof runs: #{proof} (`--proof-runs`: a control proves its row once it breaks the same claim at one Then line in #{proof} runs)"]
                     end
        elapsed = ((Time.iso8601(doc[:finished_at]) - Time.iso8601(doc[:started_at])) * 1000).round
        order = doc[:order]
        order_line = if order && order[:kind] == "shuffled"
                       ["- order: shuffled, seed #{order[:seed]} (`--order shuffled:#{order[:seed]}` runs this order again)"]
                     else []
                     end
        browsers = doc[:scenarios].filter_map { "#{_1[:browser][:type]} #{_1[:browser][:version]}" if _1[:browser] }.uniq
        browser = browsers.empty? ? "- browser: none launched" : "- browser: #{browsers.join(", ")}"
        ["", commit_line, *environments, browser, selection, *order_line, *proof_line,
         "- nukadoko: #{doc[:nukadoko]}", "- run: #{doc[:run_id]}",
         "- started #{doc[:started_at]}, finished #{doc[:finished_at]} (#{duration(elapsed)})"]
      end

      # The claim as ClaimLine writes it, then where its values were
      # measured: a value no recorded channel holds is what a constant in
      # step code looks like, so the line says `measured: none`.
      def claim_line(claim, own) = "#{ClaimLine.line(claim)}#{measured_text(claim, own)}"

      def measured_text(claim, own)
        return "" if claim[:outcome] == "unobserved"

        actual = "; measured: #{channel_text(claim[:measured], own)}"
        return claim.key?(:expected_measured) ? "#{actual}; expected measured: #{channel_text(claim[:expected_measured], own)}" : actual unless claim[:each]

        declared = [*(claim[:each][:where] || []).each_with_index.map { ["where[#{_2}]", _1] }, *claim[:each][:claims].each_with_index.map { ["claims[#{_2}]", _1] }]
                   .select { _2.key?(:expected_measured) }.map { "#{_1} #{channel_text(_2[:expected_measured], own)}" }
        declared.empty? ? actual : "#{actual}; expected measured: #{declared.join(", ")}"
      end

      def channel_text(measured, own)
        return "none" unless measured

        measured[:step_record_id] == own ? measured[:channel] : "#{measured[:channel]} of #{measured[:step_record_id]}"
      end

      def claims(doc)
        named = doc[:environments].size > 1
        any_control = false
        entries = {}
        head_scenarios(doc).each do |scenario|
          scenario[:steps].each do |step|
            next unless step[:claims]

            where = "#{scenario[:feature]}:#{step[:line] || scenario[:line]}"
            control = scenario[:role] == "control"
            any_control ||= control
            marks = [*(cell_text(scenario[:environment]) if named), *("control" if control)]
            attempts = step[:attempts].to_i > 1 ? ", #{step[:attempts]} readings" : ""
            observation = step[:observation] == "unobserved" ? ", observed nothing" : ""
            head = "- #{cell_code(where)} #{cell_text(step[:text])}#{marks.empty? ? "" : " (#{marks.join(", ")})"}#{attempts}#{observation}"
            claim_lines = step[:claims].map { "  - #{cell_text(claim_line(_1, step[:step_record_id]))}" }
            key = [head, *claim_lines].join("\n")
            next if entries.key?(key)

            seen = seen_text(seen_links(step))
            entries[key] = [[scenario[:feature], step[:line] || scenario[:line]], ["#{head}#{seen.empty? ? "" : "; seen: #{seen}"}", *claim_lines]]
          end
        end
        return [] if entries.empty?

        lead = "#{CLAIMS_LEAD}#{CONTROL_NOTE if any_control}"
        seen_note = " `seen` links what the Then's pages showed right after the reading its claims were judged on, or, for a Then that read no page, " \
                    "the requests its step sent; a capture taken 100 ms or more after the reading says so. The claims judged the values above, " \
                    "not these files, and the scenario's `final.png` is the page as the scenario ended, not as it was judged."
        lead += seen_note if entries.values.any? { _2.first.include?("; seen: ") }
        ["", "## Claims", "", lead, "", *entries.values.each_with_index.sort_by { |(place, _), index| [*place, index] }.flat_map { _1.first.last }]
      end

      def where_of(finding)
        return finding[:line] ? "#{finding[:file]}:#{finding[:line]}" : finding[:file] if finding[:file]

        finding[:step] || "-"
      end

      def findings(doc)
        list = doc[:findings].reject { TABLE_CODES.include?(_1[:code]) }
        return [] if list.empty?

        ["", "## Findings", "", *list.map { "- #{_1[:severity]} `#{_1[:code]}` #{cell_text(where_of(_1))}: #{cell_text(_1[:message])}" }]
      end

      def rerun(doc)
        commands = head_scenarios(doc).filter_map { _1[:do] }.uniq
        return [] if commands.empty?

        ["", "## Rerun a failed scenario", "", "```sh", *commands, "```"]
      end
    end
  end
end
