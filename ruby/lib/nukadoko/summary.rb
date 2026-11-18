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
      LATE_NOTE = " A claim on a count of execution events that the world's stop counted again and judged otherwise says what the whole count came to, after its outcome: it was judged on lines still on their way."
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
        "unmeasured" => ["Unmeasured actions", "each step below did something nukadoko records but cannot measure, so its record has no evidence of what that action did"],
        "after-record" => ["After a step's record was written",
                           "each step below started an action, or has lines of the program's log or events, after its record was written: they are in that step's own files, and not in its record"],
        "unrecorded-log" => ["The program's log", "what of it no step's record holds"],
        "unrecorded-events" => ["The program's execution events", "what of them no step's record holds"]
      }.freeze

      module_function

      #: (Hash[Symbol, untyped]) -> String
      def render(doc)
        lines = [MARKER, *title(doc), *table(doc), *reasons(doc), *limits_section(doc), *condition(doc),
                 *removed(doc), *flags(doc), *routes(doc), *claims(doc), *findings(doc), *rerun(doc)]
        "#{lines.join("\n")}\n"
      end

      # Text outside a code span: `\` doubled first, so the `\` before a
      # `|` survives both the table parser and the inline one, and `<`
      # never opens a tag.
      #: (untyped) -> String
      def cell_text(text) = text.to_s.gsub("\\", "\\\\\\\\").gsub("|", "\\|").gsub("<", "&lt;")

      # A code span longer than any backtick run inside it.
      #: (untyped) -> String
      def code_span(text)
        text = text.to_s
        fence = "`" * ((text.scan(/`+/).map(&:size).max || 0) + 1)
        padded = text.start_with?("`") || text.end_with?("`") ? " #{text} " : text
        "#{fence}#{padded}#{fence}"
      end

      #: (untyped) -> String
      def cell_code(text) = code_span(text).gsub("|", "\\|")

      #: (Integer, String, String) -> String
      def count_of(count, one, many) = "#{count} #{count == 1 ? one : many}"

      #: (Integer) -> String
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

      #: (untyped) -> String
      def value_text(value)
        text = JSON.generate(value)
        text.length > VALUE_TEXT_LIMIT ? "#{text[0, VALUE_TEXT_LIMIT]}..." : text
      end

      # The first line with text in it; a Node throw location with its
      # source line and carets is skipped, and a line that ends in a colon
      # takes the next line after it.
      #: (untyped, ?bool) -> String?
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

      #: (untyped) -> String
      def first_error_line(message) = first_visible_line(message) || "(no message)"

      #: (Hash[Symbol, untyped]) -> String
      def cell_word(cell)
        case cell[:outcome]
        when "not-run" then "·"
        when "pass" then "pass"
        else "#{cell[:outcome]}@#{cell[:line]}"
        end
      end

      #: (Hash[Symbol, untyped]) -> Array[Hash[Symbol, untyped]]
      def head_scenarios(doc) = doc[:scenarios].reject { _1[:world] }

      #: (Hash[untyped, untyped]) -> String
      def conditions_text(conditions)
        return "none" if conditions.empty?

        conditions.map { |name, value| "#{name}: #{value.is_a?(String) ? JSON.generate(value) : value}" }.join(", ")
      end

      #: (Hash[Symbol, untyped]) -> Array[String]
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
        lines.push("", walk_sentence(doc[:walk])) if doc[:walk]
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

      #: (Hash[Symbol, untyped]) -> String
      def table_cell(cell)
        notes = [*("control" if cell[:role] == "control"), *("#{cell[:runs]} runs" if cell[:runs].to_i > 1)]
        "#{cell_word(cell)}#{notes.empty? ? "" : " (#{notes.join(", ")})"}"
      end

      #: (Hash[Symbol, untyped]) -> Array[String]
      def table(doc)
        worlds = doc[:table][:worlds]
        rows = doc[:table][:rows]
        base = doc[:table][:base]
        return [] if rows.empty?

        heading = lambda do |column|
          declared = column[:world] == "head" ? doc[:environments].find { _1[:name] == column[:environment] }&.dig(:conditions) : nil #: Hash[untyped, untyped]?
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
      #: (Hash[Symbol, untyped]) -> Array[String]
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
      #: (Hash[Symbol, untyped]) -> Array[String]
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
      #: (Hash[Symbol, untyped]) -> Array[Array[untyped]]
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

      #: (String, String) -> String
      def markdown_link(label, href)
        text = label.gsub(/[\r\n]/, " ").gsub(/[\\\[\]]/) { "\\#{_1}" }
        return "#{text} `#{href.gsub(/[\r\n]/, " ").tr("`", "'")}`" if href.match?(/[<>\n\r]/)

        "[#{text}](<#{href}>)"
      end

      #: (Array[Array[untyped]]) -> String
      def seen_text(links) = links.map { |label, href, after| "#{markdown_link(label, href)}#{after && after >= LATE_VIEW_MS ? " (taken #{after} ms after the reading)" : ""}" }.join(", ")

      #: (Hash[Symbol, untyped]) -> (^(Hash[Symbol, untyped]) -> String)?
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

      #: (Hash[Symbol, untyped]) -> Array[String]
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
      #: (Hash[Symbol, untyped]) -> String?
      def describe_failure(scenario)
        if scenario[:status] == "stopped" && scenario[:stopped]
          last = scenario[:steps][scenario[:stopped][:after_step] - 1] || {}
          parts = ["#{cell_text("step \"#{last[:text]}\"")}: #{code_span("the walk was stopped after this step with nuka step stop")}"]
          parts << "record #{code_span(last[:record])}" if last[:record]
          return parts.join("; ")
        end
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

      #: (Array[Hash[Symbol, untyped]]?) -> Array[[untyped, Integer, String]]
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

      #: (String) -> String?
      def stdout_line(stdout)
        text = stdout.gsub(ANSI, "").strip
        return nil if text.empty?

        compact = (JSON.generate(JSON.parse(text)).gsub("\u2028", "\\u2028").gsub("\u2029", "\\u2029") rescue nil) if text.start_with?("{", "[")
        return first_visible_line(text) unless compact

        compact.length > STDOUT_JSON_LIMIT ? "#{compact[0, STDOUT_JSON_LIMIT]}..." : compact
      end

      # The gaps a green verdict does not cover, computed again from
      # run.json's other fields, never read from a stored list.
      #: (Hash[Symbol, untyped]) -> Array[Hash[Symbol, untyped]]
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
        list.concat(step_limits(head).sort(&by_place))
        (doc[:worlds] || []).each { list.concat(world_limits(_1)) }
        list.sort_by.with_index { |limit, index| [LIMIT_KINDS.index(limit[:kind]), index] }
      end

      # One entry per row a judgment holds green: nukadoko checked that the
      # value is the one judged, and nothing of the judgment itself. A value
      # judged as an ARIA snapshot names what that leaves out: a change only
      # to how the page looks keeps the snapshot, and so the judgment.
      #: (Array[Hash[Symbol, untyped]]) -> Array[Hash[Symbol, untyped]]
      def judgment_limits(rows)
        rows.filter_map do |row|
          judgment = row[:judgment]
          next unless judgment && judgment[:state] == "judged"

          by = judgment[:reads].map { _1.dig(:judgment, :by) || "" }.uniq.map { code_span(_1) }.join(", ")
          aria = judgment[:reads].any? { _1[:measured] == "aria-snapshot" } ? "; it is bound to the ARIA snapshot, so a change only to how the page looks keeps it current" : ""
          # Under --base, a judgment the change itself brought is the change
          # judging its own output, which the reviewer reads first.
          added = judgment[:reads].any? { _1.dig(:judgment, :in_base) == false } ? " that this change added" : ""
          { kind: "judgment", feature: row[:feature], line: row[:line], text: row[:name],
            detail: "stands on a judgment by #{by}#{added}: nukadoko checked that the value is the one judged, not the judgment#{aria}" }
        end
      end

      # How many unmeasured actions one entry names before it counts the rest.
      UNMEASURED_SHOWN = 3

      # Per step: what it did that nukadoko saw and could not measure
      # (`observed.unmeasured`), and what reached its files after its record
      # was written. Under `--repeat` the same step with the same gap is one
      # entry, citing its first record.
      #: (Array[Hash[Symbol, untyped]]) -> Array[Hash[Symbol, untyped]]
      def step_limits(head)
        limits = {} #: Hash[Hash[Symbol, untyped], Hash[Symbol, untyped]]
        add = ->(limit) { limits[limit.except(:record)] ||= limit }
        head.each do |scenario|
          scenario[:steps].each do |step|
            at = { feature: scenario[:feature], line: step[:line] || scenario[:line], text: step[:text], environment: scenario[:environment], record: step[:record] }.compact
            unmeasured = step.dig(:observed, :unmeasured) || []
            if unmeasured.any?
              shown = unmeasured.first(UNMEASURED_SHOWN).map { "#{_1[:kind].sub("_", " ")} #{code_span(_1[:detail])}" }
              shown << "and #{unmeasured.size - UNMEASURED_SHOWN} more" if unmeasured.size > UNMEASURED_SHOWN
              fix = unmeasured.any? { _1[:kind] == "child_process" } ? { fix: "start a process with `run_command` to record it" } : {}
              add.({ kind: "unmeasured", **at, detail: shown.join(", "), **fix })
            end
            unjudged = unjudged_failures(step)
            add.({ kind: "unmeasured", **at, detail: unjudged.join(", ") }) if unjudged.any?
            late = late_items(step)
            add.({ kind: "after-record", **at, detail: late.join(", ") }) if late.any?
          end
        end
        limits.values
      end

      # What of a step's failures underneath could not be seen: its cell
      # was judged without them.
      #: (Hash[Symbol, untyped]) -> Array[String]
      def unjudged_failures(step)
        unseen = step.dig(:underneath, :unseen)
        return [] unless unseen

        http = if !unseen.key?(:http_lines) then []
               elsif unseen[:http_lines].nil? then ["#{code_span("http.jsonl")} could not be read, so no response status of the step was judged"]
               else ["#{count_of(unseen[:http_lines], "request", "requests")} with no readable line in #{code_span("http.jsonl")}, whose status was not judged"]
               end
        errors = unseen[:page_errors] ? ["#{count_of(unseen[:page_errors], "page error", "page errors")} past the record's cap, not judged"] : []
        http + errors
      end

      # What reached a step's own files after its record was written: this
      # is the one place that says those lines exist, and names their file.
      #: (Hash[Symbol, untyped]) -> Array[String]
      def late_items(step)
        items = [] #: Array[String]
        started = step[:after_step_end]
        if started
          parts = [*("#{count_of(started[:requests], "request", "requests")} in #{code_span(started[:http] || "http.jsonl")}" if started[:requests].to_i.positive?),
                   *(count_of(started[:processes], "process", "processes") if started[:processes].to_i.positive?),
                   *("#{count_of(started[:mcp], "MCP call", "MCP calls")} in #{code_span("mcp.jsonl")}" if started[:mcp].to_i.positive?)]
          items << "started after the step ended: #{parts.join(", ")}" if parts.any?
        end
        { program_log_late: "log", events_late: "events" }.each do |key, what|
          late = step[key]
          next unless late

          lines = count_of(late[:lines], "line", "lines")
          items << (late[:file].nil? ? "#{lines} of the program's #{what} after the step ended, which could not be written" : "#{lines} of the program's #{what} after the step ended, in #{code_span(late[:file])}")
        end
        items
      end

      # Once per world, what of the program's log and execution events no
      # step's record holds. A head step's late lines are its own entry, so
      # the world names its late count only when it is the pattern a program
      # that buffers its output on a pipe makes, or when the world is the
      # base's or the old one.
      #: (Hash[Symbol, untyped]) -> Array[Hash[Symbol, untyped]]
      def world_limits(world)
        tree = world[:tree] || "head"
        at = { environment: world[:name], world: tree }
        limits = [] #: Array[Hash[Symbol, untyped]]
        not_read = "not read, since the program runs at #{world[:url] || "a URL"}, which nukadoko did not start"
        late_log = ->(count) { "#{count_of(count, "line", "lines")} carrying a step's trace id arrived after that step ended (#{code_span("program-log-late.txt")})" }
        if world.key?(:program_log) && world[:program_log].nil?
          limits << { kind: "unrecorded-log", **at, detail: not_read }
        elsif (log = world[:program_log]) && log[:stamped].positive?
          if log[:tagged].zero?
            limits << { kind: "unrecorded-log", **at, detail: "carries no trace ids, so each step's slice of it is empty" }
          elsif log[:late].positive? && log[:lines].zero?
            limits << { kind: "unrecorded-log", **at,
                        detail: "#{late_log.(log[:late])}, and none in time, which is what a program that buffers its output on a pipe looks like",
                        fix: "if that is the cause, set `STDOUT.sync = true` in Ruby, or `PYTHONUNBUFFERED=1` for Python" }
          elsif log[:late].positive? && tree != "head"
            limits << { kind: "unrecorded-log", **at, detail: late_log.(log[:late]) }
          end
        end
        if world.key?(:events) && world[:events].nil?
          limits << { kind: "unrecorded-events", **at, detail: not_read }
        elsif (events = world[:events])
          if events[:lines].zero?
            limits << { kind: "unrecorded-events", **at, detail: "the program wrote no line to the file #{code_span("{events}")} names, so no step's record has an event" }
          else
            kinds = (events[:undefined_kinds] || {}).to_a
            facts = [
              *("#{count_of(events[:late], "line", "lines")} carrying a step's trace id arrived after that step ended (#{code_span("events-late.jsonl")})" if events[:late].positive? && tree != "head"),
              *("#{count_of(events[:unreadable], "line is", "lines are")} not one readable line of the format" if events[:unreadable].positive?),
              *("#{count_of(kinds.sum { _2 }, "line names", "lines name")} a kind the format does not define (#{kinds.map { code_span(_1.first.to_s) }.join(", ")})" if kinds.any?)
            ]
            if facts.any?
              copy = events[:file].nil? ? "the world's copy of the file could not be written" : "the whole file is in #{code_span(events[:file])}"
              limits << { kind: "unrecorded-events", **at, detail: "#{facts.join("; ")}; #{copy}" }
            end
          end
        end
        limits
      end

      #: (Hash[Symbol, untyped], Array[Hash[Symbol, untyped]]) -> Hash[Symbol, untyped]?
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

      #: (Hash[Symbol, untyped]) -> String
      def closer_text(limit) = [*("do: #{code_span(limit[:do])}" if limit[:do]), *("fix: #{limit[:fix]}" if limit[:fix])].join("; ")

      #: (Hash[Symbol, untyped], bool) -> String
      def limit_place(limit, named)
        return limit[:environment] ? "world #{cell_text(limit[:world].nil? || limit[:world] == "head" ? limit[:environment] : "#{limit[:environment]} (#{limit[:world]})")}" : "" unless limit[:feature]

        environment = named && limit[:environment] ? " (#{cell_text(limit[:environment])})" : ""
        "#{code_span("#{limit[:feature]}:#{limit[:line]}")}#{limit[:text] ? " #{cell_text(limit[:text])}" : ""}#{environment}"
      end

      #: (Hash[Symbol, untyped]) -> Array[String]
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

      #: (Array[String]) -> String
      def tag_flags(expressions) = code_span(expressions.map { "--tag #{JSON.generate(_1)}" }.join(" "))

      #: (Hash[Symbol, untyped]) -> Array[String]
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
      #: (Hash[Symbol, untyped], String?) -> String
      def claim_line(claim, own) = "#{ClaimLine.line(claim)}#{after_world_stop_text(claim)}#{measured_text(claim, own)}"

      # A claim on a count of execution events the world's stop judged
      # otherwise was judged on lines still on their way: its line says what
      # the whole count came to, since its outcome proves nothing.
      #: (Hash[Symbol, untyped]) -> String
      def after_world_stop_text(claim)
        after = (claim[:each] ? nil : claim[:after_world_stop]) #: Hash[Symbol, untyped]?
        return "" if after.nil? || after[:outcome] == claim[:outcome]

        "; after the world stopped, #{after[:reason]}, and the cell is broke"
      end

      #: (Hash[Symbol, untyped], String?) -> String
      def measured_text(claim, own)
        return "" if claim[:outcome] == "unobserved"

        actual = "; measured: #{channel_text(claim[:measured], own)}"
        return claim.key?(:expected_measured) ? "#{actual}; expected measured: #{channel_text(claim[:expected_measured], own)}" : actual unless claim[:each]

        declared = [*(claim[:each][:where] || []).each_with_index.map { ["where[#{_2}]", _1] }, *claim[:each][:claims].each_with_index.map { ["claims[#{_2}]", _1] }]
                   .select { _2.key?(:expected_measured) }.map { "#{_1} #{channel_text(_2[:expected_measured], own)}" }
        declared.empty? ? actual : "#{actual}; expected measured: #{declared.join(", ")}"
      end

      #: (Hash[Symbol, untyped]?, String?) -> String
      def channel_text(measured, own)
        return "none" unless measured

        measured[:step_record_id] == own ? measured[:channel] : "#{measured[:channel]} of #{measured[:step_record_id]}"
      end

      #: (Hash[Symbol, untyped]) -> Array[String]
      def claims(doc)
        named = doc[:environments].size > 1
        any_control = false
        any_late = false
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
            any_late ||= step[:claims].any? { !after_world_stop_text(_1).empty? }
            claim_lines = step[:claims].map { "  - #{cell_text(claim_line(_1, step[:step_record_id]))}" }
            key = [head, *claim_lines].join("\n")
            next if entries.key?(key)

            seen = seen_text(seen_links(step))
            entries[key] = [[scenario[:feature], step[:line] || scenario[:line]], ["#{head}#{seen.empty? ? "" : "; seen: #{seen}"}", *claim_lines]]
          end
        end
        return [] if entries.empty?

        lead = "#{CLAIMS_LEAD}#{CONTROL_NOTE if any_control}#{LATE_NOTE if any_late}"
        seen_note = " `seen` links what the Then's pages showed right after the reading its claims were judged on, or, for a Then that read no page, " \
                    "the requests its step sent; a capture taken 100 ms or more after the reading says so. The claims judged the values above, " \
                    "not these files, and the scenario's `final.png` is the page as the scenario ended, not as it was judged."
        lead += seen_note if entries.values.any? { _2.first.include?("; seen: ") }
        ["", "## Claims", "", lead, "", *entries.values.each_with_index.sort_by { |(place, _), index| [*place, index] }.flat_map { _1.first.last }]
      end

      FLAG_VERDICTS = %i[held proven failed unproven moved].freeze
      # At most this many routes are named in one line of "Routes"; the
      # rest are counted, and run.json's `routes` names every one.
      ROUTES_NAMED = 20

      # A flag's name, side, and gate are the program's text: a line break
      # in one would end the list item, so control characters are escaped.
      #: (String) -> String
      def program_word(text) = text.to_s.gsub(/[\u0000-\u001f\u007f\u{2028}\u{2029}]/) { format("\\u%04x", _1.ord) }

      #: (Hash[Symbol, untyped]) -> Array[Hash[Symbol, untyped]]
      def head_worlds(doc) = (doc[:worlds] || []).select { _1[:tree].nil? || _1[:tree] == "head" }

      # One line per flag and side of run.json's `flags`: its counts, and
      # the gates its lines named, or that no criterion evaluated a side the
      # flags list declares. A world whose flags list was not read is named,
      # so a missing side is never read as one the program does not have.
      #: (Hash[Symbol, untyped]) -> Array[String]
      def flags(doc)
        rows = doc[:flags] || []
        unread = head_worlds(doc).select { _1.dig(:lists, :flags, :error) }
        return [] if rows.empty? && unread.empty?

        lines = rows.map do |row|
          flag = "- #{code_span(program_word(row[:name]))} #{code_span(program_word(row[:side]))}"
          next "#{flag}, no criterion's steps evaluated it on this side" if row[:criteria].empty?

          counts = FLAG_VERDICTS.select { row[:counts][_1].positive? }.map { "#{row[:counts][_1]} #{_1}" }
          counts << "#{row[:counts][:controls]} only in controls" if row[:counts][:controls].positive?
          gates = row[:criteria].flat_map { |criterion| criterion[:cells].flat_map { _1[:gates] } }.uniq.sort { |a, b| Events.by_gate(a, b) }
          named = gates.compact.map { code_span(program_word(_1)) }
          tail = [*("gates #{named.join(", ")}" if named.any?), *("only this side was evaluated" if row[:only_side_evaluated]),
                  *("no flags list that was read declares this side" if row[:listed_in]&.empty?)]
          "#{flag}, #{count_of(row[:criteria].size, "criterion", "criteria")}#{counts.empty? ? "" : ": #{counts.join(", ")}"}#{tail.map { "; #{_1}" }.join}"
        end
        lead = ["Each line counts the criteria whose steps evaluated the flag on the side the program's lines named, by their verdict in the table.",
                "One seen on that side only in controls is counted apart, since its verdict is about another side.",
                "`gates` lists the gates those lines named, and a line may name none.", ""]
        ["", "## Flags", "", *(rows.empty? ? [] : lead), *lines,
         *unread.map { "- World #{code_span(program_word(_1[:name]))} read no flags list (`program-list-unread` under Findings), so a side of a flag its steps never evaluated may not stand here." }]
      end

      #: (Hash[Symbol, untyped]) -> String
      def route_name(route) = code_span(program_word(route[:route].nil? ? route[:method] : "#{route[:method]} #{route[:route]}"))

      #: (Array[String]) -> String
      def named_list(names)
        shown = names.first(ROUTES_NAMED).join(", ")
        names.size > ROUTES_NAMED ? "#{shown}, and #{names.size - ROUTES_NAMED} more" : shown
      end

      # The places of run.json's `routes` no step reached: the listed routes
      # no head step requested, split from those whose handler a request
      # reached through another route, then the requests the lists do not
      # account for. A world whose list was not read is named.
      #: (Hash[Symbol, untyped]) -> Array[String]
      def routes(doc)
        heads = head_worlds(doc)
        unread = heads.select { _1.dig(:lists, :routes, :error) }
        routes = doc[:routes] || []
        return [] if unread.empty? && doc[:routes].nil?

        read = heads.select { _1.dig(:lists, :routes)&.key?(:error) && _1.dig(:lists, :routes, :error).nil? }.map { _1[:name] }.uniq
        listed = routes.select { _1[:listed_in].any? }
        requested = listed.select { _1[:requests].positive? }
        through = {} #: Hash[String, Array[Hash[Symbol, untyped]]]
        routes.each { |route| route[:handlers].each { (through[_1] ||= []) << route } if route[:requests].positive? }
        gaps = [] #: Array[String]
        aliases = [] #: Array[String]
        listed.each do |route|
          next if route[:requests].positive?

          others = route[:handlers].flat_map { through[_1] || [] }
          if route[:handlers].any? && route[:handlers].all? { through.key?(_1) }
            aliases << "#{route_name(route)} through #{others.map { route_name(_1) }.uniq.join(", ")}"
          else
            gaps << route_name(route)
          end
        end
        unlisted = routes.filter_map do |route|
          next nil if route[:route].nil?

          requests = route[:criteria].sum { |c| c[:cells].sum { read.include?(_1[:environment]) && !route[:listed_in].include?(_1[:environment]) ? _1[:requests] : 0 } }
          requests.zero? ? nil : [route, requests]
        end
        unmatched = routes.select { _1[:route].nil? && _1[:requests].positive? }
        same = listed.all? { |route| read.all? { route[:listed_in].include?(_1) } }
        lists = if read.size == 1 then "the program's routes list names"
                elsif same then "the program's routes list names (the same in #{read.size} worlds)"
                else "the routes lists of #{read.size} worlds name"
                end
        lines = [
          *(doc[:routes].nil? ? [] : ["Head steps requested #{requested.size} of the #{count_of(listed.size, "route", "routes")} #{lists}.",
                                      "A request says which route the program matched, not that a step checked what it answered.", ""]),
          *("- Never requested (#{gaps.size}): #{named_list(gaps)}" if gaps.any?),
          *("- Never requested, though a route with its handler was (#{aliases.size}): #{named_list(aliases)}" if aliases.any?),
          *("- #{count_of(unlisted.sum(&:last), "request", "requests")} to a route its world's list does not name: #{named_list(unlisted.map { "#{route_name(_1)} #{_2}" })}" if unlisted.any?),
          *("- #{count_of(unmatched.sum { _1[:requests] }, "request", "requests")} the program matched to no route: #{named_list(unmatched.map { "#{route_name(_1)} #{_1[:requests]}" })}" if unmatched.any?),
          *unread.map { "- World #{code_span(program_word(_1[:name]))} read no routes list (`program-list-unread` under Findings), so none of its routes stands here." }
        ].compact
        lines.pop if lines.last == ""
        ["", "## Routes", "", *lines]
      end

      #: (Hash[Symbol, untyped]) -> String
      def where_of(finding)
        return finding[:line] ? "#{finding[:file]}:#{finding[:line]}" : finding[:file] if finding[:file]

        finding[:step] || "-"
      end

      #: (Hash[Symbol, untyped]) -> Array[String]
      def findings(doc)
        list = doc[:findings].reject { TABLE_CODES.include?(_1[:code]) }
        return [] if list.empty?

        ["", "## Findings", "", *list.map { "- #{_1[:severity]} `#{_1[:code]}` #{cell_text(where_of(_1))}: #{cell_text(_1[:message])}" }]
      end

      # The heading names what the commands under it rerun: a stopped walk
      # did not fail, so a heading that called it failed would state
      # something false.
      #: (Hash[Symbol, untyped]) -> Array[String]
      def rerun(doc)
        named = head_scenarios(doc).select { _1[:do] }
        commands = named.map { _1[:do] }.uniq
        return [] if commands.empty?

        stopped = named.any? { _1[:status] == "stopped" }
        failed = named.any? { _1[:status] != "stopped" }
        what = if failed && stopped then "failed or stopped"
               elsif stopped then "stopped"
               else "failed"
               end
        ["", "## Rerun a #{what} scenario", "", "```sh", *commands, "```"]
      end

      # A walk is a run that paused after each step for an answer: its
      # verdicts were measured, but between steps the world and the browser
      # were open to anything, which no record covers. The longest pause
      # says how long that was.
      #: (Hash[Symbol, untyped]) -> String
      def walk_sentence(walk)
        longest = [0, *walk[:pauses].map { ((Time.iso8601(_1[:answered_at]) - Time.iso8601(_1[:paused_at])) * 1000).round }].max
        "Walked one step at a time (`nuka run --step`): #{count_of(walk[:pauses].size, "pause", "pauses")}, the longest #{duration(longest)}. " \
          "Between steps the world and the browser were open to anything, so this run is not the run a reviewer approves."
      end
    end
  end
end
