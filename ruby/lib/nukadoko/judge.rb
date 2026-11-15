# frozen_string_literal: true
# rbs_inline: enabled

require "json"
require "time"

# `nuka judge <file>:<line>`, the one way a judgment gets into a judgment
# file (docs/spec.md "Judgments"). Without a verdict flag it shows what the
# criterion asks a judge: each value its Then read, the quality the
# sentence names, and where the record keeps the value. With `--meets` or
# `--misses`, `--by`, and `--because` it records one judgment of each.
#
# It checks what a machine can, and only that: the run judged this
# criterion, its required head cells passed, each value is in a channel
# nukadoko recorded, and the value the step record holds has the digest
# run.json recorded, so a judgment can only cite a value a run wrote down.
# It never checks the judgment, nor who made it: `--by` is a name, and the
# commit that adds the file, with its review, is the record of who judged.
# It shows and records; it never runs.
module Nukadoko
  class CLI
    class Judge
      RUNS = File.join(".nukadoko", "runs")

      #: (String, Array[String], Hash[String, Array[String]], json: bool, out: IO) -> void
      def initialize(project, rest, options, json:, out:)
        @project = project
        @target = rest.first.to_s
        @run_name = options["--run"]&.last
        @meets = options.key?("--meets")
        @misses = options.key?("--misses")
        @by = options["--by"]&.last
        @because = options["--because"]&.last
        @json = json
        @out = out
      end

      #: () -> Integer
      def call
        return refused("--meets and --misses say opposite things: give one") if @meets && @misses

        place = parse_target(@target) or return refused("#{@target} names no criterion: write it as <feature file>:<scenario line>")
        verdict = (@meets && "meets") || (@misses && "misses")
        if verdict && (@by.to_s.strip.empty? || @because.to_s.strip.empty?)
          return refused("a judgment needs --by, the judge's name, and --because, why the value meets or misses the sentence, in one sentence")
        end
        return refused("--because is one sentence, on one line") if verdict && @because.to_s.match?(/[\r\n]/)

        target = "#{place[:feature]}:#{place[:line]}"
        rerun = "nuka run #{Engine::Selection.shell_word(target)}"
        run = run_named(@run_name)
        unless run
          return refused(@run_name ? "no run that ended is named #{@run_name}" : "no run has ended in this project, so no value was read to judge", run: rerun)
        end
        row = run[:table][:rows].find { _1[:feature] == place[:feature] && _1[:line] == place[:line] }
        values = row ? Engine::Judgments.judged_values(row, run[:scenarios]) : []
        why = unjudgeable(row, target, run, values)
        return refused(why, run: rerun) if why

        file = Engine::JudgmentFile.read(@project, place[:feature])
        return refused("the judgments of #{place[:feature]} were not read: #{file[:problem]}") if file[:problem]

        run_dir = File.join(@project, run[:run_dir] || File.join(RUNS, run[:run_id]))
        reads = Engine::Judgments.read_each(values, row[:name], file[:entries])
        shown = values.each_with_index.map do |value, index|
          read = reads.fetch(index)
          if verdict
            if read[:state] == "uncitable"
              return refused("line #{read[:line]} read #{read[:value_from]}, which no channel of a step record holds, so a judgment cannot cite it")
            end

            record = begin
              JSON.parse(File.read(File.join(run_dir, value[:record].to_s, "record.json"), encoding: "UTF-8"))
            rescue StandardError => e
              return refused("#{run[:run_id]} holds no readable step record for line #{value[:line]}: #{e.message}")
            end
            disagree = record_disagrees(value, record)
            if disagree
              return refused(disagree, fix: "a run's records changed after it ended, so neither can be cited: run the criterion again, and judge the value the new run reads", run: rerun)
            end
          end
          { read: read, value: value[:value], seen: seen_of(run, read) }
        end
        return show(target, row, run, shown, place) unless verdict

        record(target, row, run, shown, place, file[:entries], verdict, rerun)
      end

      private

      #: (String) -> Hash[Symbol, untyped]?
      def parse_target(target)
        match = /\A(.+):([1-9][0-9]*)\z/.match(target) or return nil
        { feature: match[1].to_s, line: match[2].to_i }
      end

      # The run a name names (its id or its directory), or the newest run
      # that ended.
      #: (String?) -> Hash[Symbol, untyped]?
      def run_named(name)
        runs = Dir.glob(File.join(@project, RUNS, "*", "run.json")).sort.filter_map do |file|
          document = JSON.parse(File.read(file, encoding: "UTF-8"), symbolize_names: true)
          document if document.is_a?(Hash) && document[:run_id] == File.basename(File.dirname(file))
        rescue JSON::ParserError
          nil
        end
        return runs.find { _1[:run_id] == name || _1[:run_dir] == name || File.basename(_1[:run_dir].to_s) == name } if name

        runs.max_by { [(Time.iso8601(_1[:started_at].to_s) rescue Time.at(0)), _1[:run_id]] }
      end

      #: (Hash[Symbol, untyped]?, String, Hash[Symbol, untyped], Array[untyped]) -> String?
      def unjudgeable(row, target, run, values)
        return "#{run[:run_id]} ran no criterion at #{target}" unless row

        required = row[:cells].select { _1[:world] == "head" && _1[:role] == "required" }
        if required.empty? || required.any? { _1[:outcome] != "pass" }
          return "#{target} did not pass in #{run[:run_id]} (#{row[:reason]}), and only a criterion whose required cells passed has a value to judge"
        end
        return "#{target} asks for no judgment in #{run[:run_id]}: no Then of it has a judged-as claim that read a value" if values.empty?

        nil
      end

      # Why the value a step record holds for a read is not the one run.json
      # recorded, or nil when the two agree.
      #: (Hash[Symbol, untyped], untyped) -> String?
      def record_disagrees(read, record)
        name = read[:record] || "the step record"
        claims = record.is_a?(Hash) ? record["claims"] : nil
        claim = (claims.is_a?(Array) ? claims[read[:claim]] : nil) #: untyped
        return "#{name} holds no value for claim #{read[:claim]}" unless claim.is_a?(Hash) && claim.key?("actual")
        return "#{name} records claim #{read[:claim]} as #{claim["outcome"]}, not for-judgment" unless claim["outcome"] == "for-judgment"

        digest = Engine::Judgments.value_digest(claim["actual"])
        digest == read[:value_digest] ? nil : "#{name} holds a value whose digest is #{digest}, and run.json recorded #{read[:value_digest]}, so the two records disagree"
      end

      #: (Hash[Symbol, untyped], Hash[Symbol, untyped]) -> Array[String]
      def seen_of(run, read)
        scenario = run[:scenarios].find { |entry| !entry[:world] && entry[:environment] == read[:environment] && entry[:steps].any? { _1[:line] == read[:line] && _1[:text] == read[:step] } }
        step = scenario && scenario[:steps].find { _1[:line] == read[:line] && _1[:text] == read[:step] }
        (step&.dig(:judged_view, :pages) || []).flat_map { [_1.dig(:screenshot, :file), _1.dig(:aria, :file)].grep(String) }
      end

      #: (untyped) -> Array[String]
      def value_block(value)
        text = value.is_a?(String) ? value : JSON.pretty_generate(value)
        text.split("\n", -1).map { "    #{_1}" }
      end

      #: (String, Hash[Symbol, untyped], Hash[Symbol, untyped], Array[Hash[Symbol, untyped]], Hash[Symbol, untyped]) -> Integer
      def show(target, row, run, shown, place)
        if @json
          values = shown.map { |entry| { **entry[:read], value: entry[:value], seen: entry[:seen] } }
          return emit({ run_id: run[:run_id], feature: place[:feature], line: place[:line], criterion: row[:name], values: values })
        end

        dir = run[:run_dir] || File.join(RUNS, run[:run_id])
        lines = [%(#{target} "#{row[:name]}" in #{run[:run_id]}: #{shown.size == 1 ? "1 value" : "#{shown.size} values"} to judge)]
        shown.each do |entry|
          read = entry[:read]
          lines << %(- line #{read[:line]} "#{read[:step]}", claim #{read[:claim]}, in #{read[:environment]}: #{read[:state]})
          lines << "  quality: #{read[:quality] || "the sentence"}"
          lines << "  value, #{read[:value_from]}, measured #{read[:measured] || "none"}:"
          lines.concat(value_block(entry[:value]))
          lines << "  digest: #{read[:value_digest]}"
          lines << "  record: #{File.join(dir, read[:record], "record.json")}" if read[:record]
          lines << "  seen: #{entry[:seen].map { File.join(dir, _1) }.join(", ")}" if entry[:seen].any?
          judgment = read[:judgment]
          lines << "  judgment: #{judgment[:verdict]} by #{judgment[:by]} in #{judgment[:run_id]}: #{judgment[:because]}" if judgment
        end
        @out.puts lines
        @out.puts "  fix: judge each value against its quality, then record it: nuka judge #{Engine::Selection.shell_word(target)} --run #{run[:run_id]} " \
                  "--meets or --misses --by <who> --because <one sentence>"
        0
      end

      #: (String, Hash[Symbol, untyped], Hash[Symbol, untyped], Array[Hash[Symbol, untyped]], Hash[Symbol, untyped], Array[Hash[Symbol, untyped]], String, String) -> Integer
      def record(target, row, run, shown, place, entries, verdict, rerun)
        at = Time.now.utc.iso8601(3)
        shown.each do |entry|
          read = entry[:read]
          entries = Engine::Judgments.add(entries, { criterion: row[:name], then: read[:step], claim: read[:claim], quality: read[:quality],
                                                     value_digest: read[:value_digest], value: entry[:value], verdict: verdict,
                                                     because: @because.to_s.strip, by: @by.to_s.strip, run_id: run[:run_id],
                                                     commit: run.dig(:commit, :sha), at: at })
        end
        written = Engine::JudgmentFile.write(@project, place[:feature], entries)
        if @json
          return emit({ run_id: run[:run_id], feature: place[:feature], line: place[:line], verdict: verdict, file: written,
                        value_digests: shown.map { _1[:read][:value_digest] }, do: rerun })
        end

        shown.each { @out.puts [verdict, target, "line #{_1[:read][:line]} claim #{_1[:read][:claim]}", _1[:read][:value_digest]].join("\t") }
        $stderr.puts "wrote #{written}: commit it, so its review records who judged; the next run reads #{target} against it"
        $stderr.puts "  do: #{rerun}"
        0
      end

      #: (Hash[Symbol, untyped]) -> Integer
      def emit(fields)
        @out.puts JSON.pretty_generate({ schema_version: Engine::RunRecord::SCHEMA_VERSION, nukadoko: VERSION, command: "judge", **fields, verdict: "passed", findings: [] })
        0
      end

      #: (String, ?fix: String?, ?run: String?) -> Integer
      def refused(message, fix: nil, run: nil)
        finding = Engine::Refusal.new("judgment-refused", message, fix: fix, run: run).to_h("judge")
        if @json
          @out.puts JSON.pretty_generate({ schema_version: Engine::RunRecord::SCHEMA_VERSION, nukadoko: VERSION, command: "judge", verdict: "refused", findings: [finding] })
        else
          @out.puts [finding[:severity], finding[:code], Engine::Summary.where_of(finding), finding[:message]].join("\t")
          @out.puts "  fix: #{finding[:fix]}" if finding[:fix]
          @out.puts "  do: #{finding[:do]}" if finding[:do]
        end
        2
      end
    end
  end
end
