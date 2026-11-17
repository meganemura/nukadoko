# frozen_string_literal: true
# rbs_inline: enabled

require "digest"
require "json"

# Judgments (docs/spec.md "Judgments"): the verdicts on a criterion that no
# compare can give, such as whether a text is friendly. A Then asks for one
# with a `judged-as` claim; the run reads the value and records it, and a
# reader judges it after the run and commits the judgment. nukadoko checks
# two things alone, both exactly: that a judgment cites a value this run's
# records hold (by its digest), and that the value did not change since.
# The judgment itself is never checked, and never folded into the machine
# verdict: a row keeps its verdict from the cells, and gains a `judgment`
# beside it, whose state has a gate of its own.
#
# Pure, and in the words the TypeScript engine uses. The files on disk are
# lib/nukadoko/judgment_file.rb's, and recording one is the judge command's.
#
# The digest is of the value's JSON with object keys sorted, so a program
# that writes its keys in another order does not make a judgment stale,
# and with numbers written the way JavaScript writes them, so both engines
# give one value one digest.
module Nukadoko
  module Engine
    module Judgments
      # The order a row's state is chosen in: a judge's no first, then what
      # no judgment can fix, then what a new judgment fixes.
      STATE_ORDER = %w[misses uncitable stale pending judged].freeze
      # The states in the order the summary's title counts them.
      TITLE_ORDER = %w[judged misses stale pending uncitable].freeze
      ARIA_LABEL = "ARIA snapshot of"
      RECORD_FIX = "a judge who did not write the change reads the value against the sentence, then records it with nuka judge and --meets or --misses, --by, and --because"
      UNCITABLE_FIX = "read the value whole from a channel the step record holds (a response, a process's output, a file) and narrow it with view and at, " \
                      "or return the locator or page from observe so nukadoko takes its ARIA snapshot"
      ENTRY_STRINGS = %w[criterion then value_digest because by run_id at].freeze

      module_function

      #: (untyped) -> String
      def canonical_json(value)
        case value
        when Array then "[#{value.map { canonical_json(_1) }.join(",")}]"
        when Hash
          pairs = value.to_a.map { |key, item| [key.to_s, item] }.sort_by { _1[0].codepoints }
          "{#{pairs.map { |key, item| "#{JSON.generate(key)}:#{canonical_json(item)}" }.join(",")}}"
        when Float then value.finite? ? AriaSnapshot.js_number(value) : "null"
        when Integer, String, true, false, nil then JSON.generate(value)
        else JSON.generate(value.to_s)
        end
      end

      #: (untyped) -> String
      def value_digest(value) = "sha256:#{Digest::SHA256.hexdigest(canonical_json(value))}"

      # Where a judged value was measured, as a read names it: the channel,
      # with the step record that holds it when that is another step's,
      # `aria-snapshot` for a tree nukadoko took, or nil.
      #: (Hash[Symbol, untyped], String?) -> String?
      def measured_of(claim, own_record_id)
        return "aria-snapshot" if claim[:actual_from].to_s.start_with?(ARIA_LABEL)

        measured = claim[:measured] or return nil
        measured[:step_record_id] == own_record_id ? measured[:channel] : "#{measured[:channel]} of #{measured[:step_record_id]}"
      end

      # Every value the passing required head executions of `row` read for a
      # judgment, once per Then, claim, and value.
      #: (Hash[Symbol, untyped], Array[Hash[Symbol, untyped]]) -> Array[Hash[Symbol, untyped]]
      def judged_values(row, scenarios)
        required = row[:cells].select { _1[:world] == "head" && _1[:role] == "required" }.map { _1[:environment] }
        values = [] #: Array[Hash[Symbol, untyped]]
        scenarios.each do |scenario|
          next if scenario[:world] || scenario[:feature] != row[:feature] || scenario[:line] != row[:line]
          next if scenario[:role] == "control" || scenario[:status] != "passed" || !required.include?(scenario[:environment])

          scenario[:steps].each do |step|
            (step[:claims] || []).each_with_index do |claim, index|
              next if claim[:each] || claim[:outcome] != "for-judgment" || claim[:value_digest].nil?

              digest = claim[:value_digest]
              next if values.any? { _1[:step] == step[:text] && _1[:claim] == index && _1[:value_digest] == digest }

              values << { line: step[:line] || scenario[:line], step: step[:text], claim: index, environment: scenario[:environment],
                          quality: claim[:expected_text], value_from: claim[:actual_from], value_digest: digest,
                          measured: measured_of(claim, step[:step_record_id]), record: step[:record], value: claim[:actual] }
            end
          end
        end
        values
      end

      #: (Hash[Symbol, untyped], ?Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def cited(entry, extra = {})
        { value_digest: entry[:value_digest], verdict: entry[:verdict], by: entry[:by], because: entry[:because], run_id: entry[:run_id], at: entry[:at], **extra }
      end

      # Where one value stands against the judgments of its criterion: a
      # value in no recorded channel is `uncitable` whatever a file says; an
      # entry with its digest decides it; entries of the same claim that
      # cite only values this run did not read make it `stale`, citing the
      # latest of them; otherwise it is `pending`. `read_now` is every digest
      # the run read for the same claim, so a value one environment reads
      # beside a judged value another reads is a value of its own to judge.
      #: (Hash[Symbol, untyped], String, Array[Hash[Symbol, untyped]], ?Array[String]?) -> Hash[Symbol, untyped]
      def read_against(value, criterion, entries, read_now = nil)
        read_now ||= [value[:value_digest]]
        rest = value.except(:value)
        return { **rest, state: "uncitable" } if value[:measured].nil?

        same = entries.select { _1[:criterion] == criterion && _1[:then] == value[:step] && _1[:claim] == value[:claim] }
        match = same.find { _1[:value_digest] == value[:value_digest] }
        return { **rest, state: match[:verdict] == "meets" ? "judged" : "misses", judgment: cited(match) } if match
        return { **rest, state: "pending" } if same.empty? || same.any? { read_now.include?(_1[:value_digest]) }

        latest = same.sort_by { _1[:at].to_s }.last #: Hash[Symbol, untyped]
        difference = ClaimLine.equal_difference(value[:value], latest[:value])
        { **rest, state: "stale", judgment: cited(latest, { value: latest[:value], **(difference ? { difference: difference } : {}) }) }
      end

      #: (Array[Hash[Symbol, untyped]], String, Array[Hash[Symbol, untyped]]) -> Array[Hash[Symbol, untyped]]
      def read_each(values, criterion, entries)
        values.map do |value|
          now = values.select { _1[:step] == value[:step] && _1[:claim] == value[:claim] }.map { _1[:value_digest] }
          read_against(value, criterion, entries, now)
        end
      end

      # A value as a reason quotes it, cut at 120 characters of its JSON.
      #: (untyped) -> String
      def value_preview(value)
        text = JSON.generate(value)
        text.size > 120 ? "#{text[0, 117]}..." : text
      end

      #: (Hash[Symbol, untyped]) -> String
      def quality(read) = read[:quality] || "what the sentence says"

      #: (Hash[Symbol, untyped], untyped) -> String
      def read_clause(read, value)
        at = "line #{read[:line]}"
        judgment = read[:judgment] || {}
        case read[:state]
        when "judged" then "#{judgment[:by]} judged the value #{at} read as #{quality(read)}: #{judgment[:because]}"
        when "misses" then "#{judgment[:by]} judged the value #{at} read, #{value_preview(value)}, not #{quality(read)}: #{judgment[:because]}"
        when "uncitable" then "#{at} asks for a judgment of #{read[:value_from]}, which no channel of a step record holds, so no judgment can cite it"
        when "stale"
          # Where the two differ says more than two cut previews of a long
          # value, which can read the same.
          if judgment[:difference].nil?
            "#{at} read #{value_preview(value)}, and the judgment by #{judgment[:by]} in #{judgment[:run_id]} cited #{value_preview(judgment[:value])}, so it does not cover what ran"
          else
            "#{at} read another value than the one the judgment by #{judgment[:by]} in #{judgment[:run_id]} cited, so it does not cover what ran; " \
              "#{judgment[:difference]} (actual is this run's value, expected the judged one)"
          end
        else "#{at} read #{value_preview(value)} for a judgment as #{quality(read)}, and no judgment cites it"
        end
      end

      # The judgment of one row, or nil for a row that read no value for a
      # judgment.
      #: (Hash[Symbol, untyped], Array[Hash[Symbol, untyped]], Array[Hash[Symbol, untyped]]) -> Hash[Symbol, untyped]?
      def row_judgment(row, scenarios, entries)
        values = judged_values(row, scenarios)
        return nil if values.empty?

        reads = read_each(values, row[:name], entries)
        state = STATE_ORDER.find { |candidate| reads.any? { _1[:state] == candidate } }
        shown = reads.each_with_index.filter_map { |read, index| read_clause(read, values.fetch(index)[:value]) if read[:state] == state }
        { state: state, reason: shown.join("; "), reads: reads }
      end

      # The table's rows with a `judgment` on each row whose required head
      # cells all passed and read a value for a judgment. The verdict is
      # never touched.
      #: (Array[Hash[Symbol, untyped]], Array[Hash[Symbol, untyped]], ^(String) -> Array[Hash[Symbol, untyped]]) -> Array[Hash[Symbol, untyped]]
      def with_judgments(rows, scenarios, entries_of)
        rows.map do |row|
          required = row[:cells].select { _1[:world] == "head" && _1[:role] == "required" }
          next row if required.empty? || required.any? { _1[:outcome] != "pass" }

          judgment = row_judgment(row, scenarios, entries_of.(row[:feature]))
          judgment ? { **row, judgment: judgment } : row
        end
      end

      # Under --base, each judgment a read cites gains `in_base`: true when
      # the base's file already held that very judgment (the same claim,
      # value, verdict, judge, reason, and time), false when the change
      # brought it. A change cannot be trusted to judge its own output any
      # more than to rewrite its own Thens, and the old world covers only
      # the Thens. `base_entries_of` answers nil for a feature whose base
      # file could not be read, and its reads stay unmarked.
      #: (Array[Hash[Symbol, untyped]], ^(String) -> Array[Hash[Symbol, untyped]]?) -> Array[Hash[Symbol, untyped]]
      def with_base_judgments(rows, base_entries_of)
        rows.map do |row|
          judgment = row[:judgment]
          next row unless judgment && judgment[:reads].any? { _1[:judgment] }

          entries = base_entries_of.(row[:feature])
          next row unless entries

          reads = judgment[:reads].map do |read|
            cited = read[:judgment]
            next read unless cited

            held = entries.any? do |entry|
              entry[:criterion] == row[:name] && entry[:then] == read[:step] && entry[:claim] == read[:claim] &&
                %i[value_digest verdict by because at].all? { entry[_1] == cited[_1] }
            end
            { **read, judgment: { **cited, in_base: held } }
          end
          { **row, judgment: { **judgment, reads: reads } }
        end
      end

      #: (Array[Hash[Symbol, untyped]]) -> bool
      def open?(rows) = rows.any? { _1[:judgment] && _1[:judgment][:state] != "judged" }

      #: (Hash[Symbol, untyped], String) -> String
      def show_command(row, run_id) = ["nuka", "judge", "#{row[:feature]}:#{row[:line]}", "--run", run_id].map { Selection.shell_word(_1) }.join(" ")

      # One finding per row whose judgment leaves the gate red.
      #: (Array[Hash[Symbol, untyped]], String) -> Array[Hash[Symbol, untyped]]
      def findings(rows, run_id)
        rows.flat_map do |row|
          judgment = row[:judgment]
          next [] if judgment.nil? || judgment[:state] == "judged"

          base = { severity: "failed", code: "judgment-#{judgment[:state]}", file: row[:feature], line: row[:line], message: %(Scenario "#{row[:name]}" #{judgment[:reason]}) }
          case judgment[:state]
          when "uncitable" then [{ **base, fix: UNCITABLE_FIX }]
          when "misses" then [{ **base, fix: "change the program until the value meets the sentence, then run it again and have it judged again", do: show_command(row, run_id) }]
          else [{ **base, fix: RECORD_FIX, do: show_command(row, run_id) }]
          end
        end
      end

      # `entries` with `entry` in: it replaces an entry that judged the same
      # value of the same claim, and is added beside the entries of others.
      #: (Array[Hash[Symbol, untyped]], Hash[Symbol, untyped]) -> Array[Hash[Symbol, untyped]]
      def add(entries, entry)
        keys = %i[criterion then claim value_digest]
        [*entries.reject { |other| keys.all? { other[_1] == entry[_1] } }, entry]
      end

      # A judgment file's text: its entries ordered by criterion, Then,
      # claim, and time, so two judges who add one each make a diff of two
      # hunks. Keys keep the order the TypeScript engine writes.
      #: (Array[Hash[Symbol, untyped]]) -> String
      def file_text(entries)
        compare = ->(a, b) { a.to_s.codepoints <=> b.to_s.codepoints }
        ordered = entries.sort do |a, b|
          [compare.(a[:criterion], b[:criterion]), compare.(a[:then], b[:then]), a[:claim] <=> b[:claim], compare.(a[:at], b[:at]),
           compare.(a[:value_digest], b[:value_digest])].find { _1 != 0 } || 0
        end
        "#{JSON.pretty_generate({ judgments: ordered })}\n"
      end

      # A judgment file's entries, or why its text holds none: a file a
      # person edited by hand can break, and a judgment it no longer holds
      # must read as unread, never as absent.
      #: (String) -> Hash[Symbol, untyped]
      def parse_file(text)
        parsed = begin
          JSON.parse(text)
        rescue JSON::ParserError => e
          return { problem: "it is not JSON: #{e.message.lines.first.to_s.chomp}" }
        end
        list = (parsed.is_a?(Hash) ? parsed["judgments"] : nil) #: untyped
        return { problem: "it holds no judgments array" } unless list.is_a?(Array)

        list.each_with_index do |entry, index|
          return { problem: "judgments[#{index}] is not an object" } unless entry.is_a?(Hash)

          missing = ENTRY_STRINGS.find { !entry[_1].is_a?(String) }
          return { problem: "judgments[#{index}] has no text #{missing}" } if missing
          unless entry["claim"].is_a?(Numeric) && %w[meets misses].include?(entry["verdict"])
            return { problem: "judgments[#{index}] needs a claim number and a verdict of meets or misses" }
          end
        end
        { entries: list.map { |entry| entry.to_h { |key, item| [key.to_sym, item] } } }
      end
    end
  end
end
