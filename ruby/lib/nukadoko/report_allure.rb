# frozen_string_literal: true
# rbs_inline: enabled

require "digest"
require "fileutils"
require "json"
require "time"

# One run as Allure results, for `nuka report --format allure`, in the shape
# the TypeScript engine writes them (src/report/allure/): one test result
# per execution, with one step per line of the scenario, its hooks as
# fixtures in containers of their own, `categories.json`, and
# `environment.properties`. That engine writes through allure-js-commons;
# this one writes the same JSON itself, field for field, since Allure reads
# the files and nothing else.
#
# A file's name is derived from the run, the scenario execution, and its
# place in the render, never from a random id, so a second render of a run
# writes the same names and replaces what the first wrote. `historyId` and
# `testCaseId` use allure-js-commons' own formula (md5 of the full name, and
# of the parameters that are not excluded), so a result keeps the history
# the TypeScript engine's results of the same scenario built up.
#
# A failure stays as small as it can: an attachment that cannot be read
# costs that attachment, a step that cannot be mapped costs that step a
# broken entry, and a scenario that cannot be written costs its own result.
# Each is a problem the report names.
module Nukadoko
  module Engine
    module ReportAllure
      # The kinds of a step's failure, in the order categories.json lists them.
      CATEGORY_NAMES = {
        "args_invalid" => "Contract: args failed the step's schema",
        "result_invalid" => "Contract: result failed the step's schema",
        "binding_invalid" => "Contract: the step's text couldn't bind",
        "world_invalid" => "Contract: a World key's write failed its schema",
        "timeout" => "Timeout",
        "unsupported" => "Compat: unsupported step shape",
        "claim_broken" => "Claim broken",
        "unobserved" => "Claim step did not observe",
        "claim_unjudged" => "Claim could not be judged",
        "step_error" => "Step error"
      }.freeze
      # failed: the system under test broke the contract. broken: the
      # contract layer did not reach a verdict.
      FAILED_KINDS = %w[step_error result_invalid claim_broken].freeze
      MEDIA_TYPE_BY_EXTENSION = { ".txt" => "text/plain", ".html" => "text/html", ".csv" => "text/csv", ".json" => "application/json",
                                  ".xml" => "application/xml", ".png" => "image/png", ".jpg" => "image/jpeg", ".svg" => "image/svg+xml" }.freeze
      # allure-js-commons' extension for a media type, for an attachment
      # whose own name has none.
      EXTENSION_BY_MEDIA_TYPE = { "application/json" => ".json", "application/octet-stream" => ".bin", "application/xml" => ".xml",
                                  "application/zip" => ".zip", "application/vnd.allure.playwright-trace" => ".zip", "image/jpeg" => ".jpg",
                                  "image/png" => ".png", "image/svg+xml" => ".svg", "text/csv" => ".csv", "text/html" => ".html",
                                  "text/plain" => ".txt" }.freeze
      TRACE = "application/vnd.allure.playwright-trace"
      ALLURE_LABEL_TAG = /\A@allure\.label\.([^:=]+)[:=](.+)\z/
      ALLURE_ID_TAG = /\A@allure\.id[:=](.+)\z/

      # Writes the files of one render under names derived from the
      # execution being written, and keeps one execution's files from
      # landing half-written: they are kept in memory until `commit`.
      class Writer
        attr_reader :written #: Array[String]

        #: (String) -> void
        def initialize(dir)
          @dir = dir
          @written = []
          @key = ""
          @index = 0
          @pending = []
        end

        #: (String) -> void
        def begin(key)
          @key = key
          @index = 0
          @pending = []
        end

        # The next name of the execution: the first 16 bytes of the SHA-256
        # of the key and the place, with the version 8 and RFC 9562 variant
        # bits set, as the TypeScript engine names it.
        #: () -> String
        def reserve
          bytes = Digest::SHA256.digest("#{@key}\u0000#{@index}").bytes.first(16)
          @index += 1
          bytes[6] = (bytes[6] & 0x0f) | 0x80
          bytes[8] = (bytes[8] & 0x3f) | 0x80
          hex = bytes.pack("C*").unpack1("H*").to_s
          "#{hex[0, 8]}-#{hex[8, 4]}-#{hex[12, 4]}-#{hex[16, 4]}-#{hex[20..]}"
        end

        #: (untyped) -> String
        def name_of(_object) = reserve

        #: (String) -> String
        def attachment_name(extension) = "#{reserve}-attachment#{extension}"

        #: (String, String, ?note: bool) -> void
        def file(name, content, note: true)
          if note
            @pending << [name, content, nil]
          else
            atomic(File.join(@dir, name)) { File.write(_1, content) }
          end
        end

        #: (String, String) -> void
        def copy(name, source)
          raise Errno::ENOENT, source unless File.file?(source)

          @pending << [name, nil, source]
        end

        #: (Hash[Symbol, untyped]) -> void
        def result(test)
          @pending << ["#{test[:uuid]}-result.json", JSON.generate(test), nil]
        end

        #: (Hash[Symbol, untyped]) -> void
        def container(group)
          @pending << ["#{group[:uuid]}-container.json", JSON.generate(group), nil]
        end

        #: () -> void
        def discard
          @pending = []
        end

        #: () -> void
        def commit
          @pending.each do |name, content, source|
            path = File.join(@dir, name)
            atomic(path) { |temp| source ? link_or_copy(source, temp) : File.write(temp, content) }
            @written << path
          end
          @pending = []
        end

        private

        #: (String, String) -> void
        def link_or_copy(source, temp)
          File.link(source, temp)
        rescue SystemCallError
          FileUtils.cp(source, temp)
        end

        #: (String) { (String) -> void } -> void
        def atomic(path)
          temp = File.join(File.dirname(path), ".#{File.basename(path)}.tmp-#{Process.pid}-#{rand(36**6).to_s(36)}")
          yield temp
          File.rename(temp, path)
        rescue StandardError
          FileUtils.rm_f(temp) if temp
          raise
        end
      end

      module_function

      def status_for_kind(kind) = FAILED_KINDS.include?(kind) ? "failed" : "broken"

      def failure_marker(kind) = "[nukadoko.failure=#{kind}]"

      def categories
        CATEGORY_NAMES.map do |kind, name|
          { name: name, matchedStatuses: [status_for_kind(kind)], messageRegex: "#{Regexp.escape(failure_marker(kind))}[\\s\\S]*" }
        end
      end

      # Writes every result of `run` into `dir`, and returns the files it
      # wrote; what it left out goes to `warn`.
      #: (ReportRun, String, ^(String) -> void) -> Array[String]
      def write(run, dir, warn)
        FileUtils.mkdir_p(dir)
        writer = Writer.new(dir)
        environments = run.document[:environments] || []
        info = { "environment" => environments.map { _1[:name] }.join(", ") }
        info["target_version"] = environments.first[:target_version] if environments.size == 1 && environments.first[:target_version]
        begin
          writer.file("categories.json", JSON.generate(categories), note: false)
          writer.file("environment.properties", properties(info), note: false)
        rescue StandardError => e
          warn.("allure categories.json or environment.properties not written: #{e.message}")
        end
        run.scenarios.each do |scenario|
          write_scenario(run, scenario, writer, warn)
        rescue StandardError => e
          writer.discard
          warn.("allure: scenario #{scenario.json[:scenario_record_id]} was not written: #{e.message}")
        end
        writer.written
      end

      def write_scenario(run, scenario, writer, warn)
        record = scenario_record(run, scenario.json)
        writer.begin("#{record[:run_id]}\u0000#{record[:scenario_record_id]}\u0000#{record[:environment]}")
        attach = ->(target, attachment) { write_attachment(run, writer, target, attachment, warn) }
        pickle = scenario.pickle
        document = scenario.feature.document
        posix = scenario.feature.path.tr("\\", "/")
        steps = map_steps(record, scenario, document, pickle, warn)
        mapped = map_scenario(record, document, pickle, posix, run.project_name, steps, scenario.verdict)
        full_name = run.project_name ? "#{run.project_name}:#{posix}##{pickle["name"]}" : "#{posix}##{pickle["name"]}"
        test = test_result(writer, mapped, full_name, title_path(run.project_name, posix, mapped[:feature_name]), attach)
        writer.result(test)
        start = ms(record[:started_at])
        stop = ms(record[:finished_at])
        fixtures = map_hooks(record, start, stop).map { |hook| fixture(hook, attach) }
        fixtures.each do |type, value|
          writer.container({ uuid: writer.name_of(Object.new), name: value[:name], children: [test[:uuid]],
                             befores: type == "before" ? [value] : [], afters: type == "after" ? [value] : [] })
        end
        writer.commit
      end

      # What the run directory says of one execution, in the shape the
      # mapping reads: run.json's scenario entry, with its evidence under
      # the run directory.
      def scenario_record(run, json)
        document = run.document
        target = (document[:environments] || []).find { _1[:name] == json[:environment] }&.dig(:target_version)
        in_run = ->(relative) { File.join("runs", document[:run_id].to_s, relative) }
        evidence = json[:evidence] ? { **json[:evidence], dir: in_run.(json[:evidence][:dir].to_s) } : { dir: in_run.(File.join("scenarios", json[:scenario_record_id].to_s)), screenshots: [] }
        { scenario_record_id: json[:scenario_record_id], run_id: document[:run_id], status: json[:status], stopped: json[:stopped],
          environment: json[:environment], target_version: target, started_at: json[:started_at], finished_at: json[:finished_at],
          steps: json[:steps], hooks: json[:hooks] || [], evidence: evidence }
      end

      def ms(time) = (Time.iso8601(time.to_s).to_r * 1000).floor

      def title_path(project, posix, feature_name)
        dirs = posix.split("/")[0...-1] || []
        path = feature_name.empty? ? dirs : [*dirs, feature_name]
        project ? [project, *path] : path
      end

      # --- the files allure-js-commons would write ---

      def test_result(writer, mapped, full_name, title_path, attach)
        test = { uuid: writer.reserve, name: mapped[:name], historyId: nil, status: mapped[:status], statusDetails: {}, stage: "pending",
                 steps: [], attachments: [], parameters: mapped[:parameters], labels: [{ name: "language", value: "ruby" },
                                                                                      { name: "framework", value: "nukadoko" },
                                                                                      *mapped[:labels], *environment_labels],
                 links: mapped[:links], start: mapped[:start], fullName: full_name, titlePath: title_path }
        test[:description] = mapped[:description] if mapped[:description]
        test[:statusDetails] = { message: mapped[:message], **(mapped[:trace] ? { trace: mapped[:trace] } : {}) } if mapped[:message]
        mapped[:attachments].each { attach.(test, _1) }
        test[:steps] = mapped[:steps].map { |step| gwt_step(step, attach) }
        test[:testCaseId] = Digest::MD5.hexdigest(full_name)
        test[:historyId] = "#{test[:testCaseId]}:#{Digest::MD5.hexdigest(parameters_text(test[:parameters]))}"
        test[:stop] = mapped[:stop]
        test.delete(:description) unless test[:description]
        test
      end

      # `ALLURE_LABEL_*` as the process rendering the report sees it: the
      # person rendering chooses those, and the run recorded none.
      def environment_labels
        ENV.filter_map { |key, value| (name = key.delete_prefix("ALLURE_LABEL_").strip) && key.start_with?("ALLURE_LABEL_") && !name.empty? ? { name: name, value: value } : nil }
      end

      # The parameters that join historyId, as allure-js-commons orders
      # them: by name, then by value.
      def parameters_text(parameters)
        parameters.reject { _1[:excluded] }.sort { |a, b| [collation(a[:name]), collation(a[:value])] <=> [collation(b[:name]), collation(b[:value])] }
                  .map { "#{_1[:name]}:#{_1[:value]}" }.join(",")
      end

      # A sort key near the Unicode collation JavaScript's localeCompare
      # uses: punctuation before digits before letters, letters without
      # case first and lowercase before uppercase on a tie.
      def collation(text)
        primary = text.to_s.each_char.map do |char|
          rank = if char.match?(/[[:alpha:]]/) then 3
                 elsif char.match?(/[[:digit:]]/) then 2
                 elsif char.match?(/[[:space:]]/) then 0
                 else 1
                 end
          [rank, char.downcase]
        end
        [primary, text.to_s.swapcase]
      end

      def step_result(name, status, start, stop, parameters: [], message: nil)
        { status: status, statusDetails: message ? { message: message } : {}, stage: "finished", steps: [], attachments: [],
          parameters: parameters, start: start, name: name, stop: stop }
      end

      def gwt_step(step, attach)
        result = step_result(step[:name], step[:status], step[:start], step[:stop], parameters: step[:parameters], message: step[:message])
        step[:attachments].each { attach.(result, _1) }
        result[:steps] = child_steps(step[:child_steps])
        result
      end

      def child_steps(children)
        children.map do |child|
          result = step_result(child[:name], child[:status], child[:start], child[:stop], parameters: child[:parameters] || [])
          result[:steps] = child_steps(child[:child_steps] || [])
          result
        end
      end

      def fixture(hook, attach)
        value = { status: hook[:status], statusDetails: hook[:message] ? { message: hook[:message] } : {}, stage: "finished", steps: [],
                  attachments: [], parameters: hook[:declared_parameters], start: hook[:start], name: hook[:name], stop: hook[:stop] }
        hook[:attachments].each { attach.(value, _1) }
        value[:steps] = child_steps(hook[:child_steps])
        [hook[:type], value]
      end

      # An attachment that cannot be read, or whose path is refused, costs
      # that attachment only.
      def write_attachment(run, writer, target, attachment, warn)
        if attachment[:path]
          begin
            source = run.resolve_recorded(attachment[:path])
          rescue ArgumentError => e
            return warn.("allure: could not attach #{attachment[:path]}: #{e.message}")
          end
          extension = File.extname(source)
          name = writer.attachment_name(extension.empty? ? EXTENSION_BY_MEDIA_TYPE.fetch(attachment[:type], "") : extension)
          begin
            writer.copy(name, source)
          rescue SystemCallError, IOError => e
            return warn.("allure: could not attach #{attachment[:path]}: #{e.message}")
          end
        else
          name = writer.attachment_name(attachment[:extension])
          writer.file(name, attachment[:content])
        end
        target[:attachments] << { name: attachment[:name], source: name, type: attachment[:type] }
      end

      # A Java properties file, escaped as allure-js-commons escapes it.
      def properties(info)
        info.map { |key, value| "#{escape(key, true, separators: true)}=#{escape(value.to_s, false)}" }.join("\n")
      end

      def escape(text, key, separators: false)
        leading = true
        text.encode("UTF-16BE").unpack("n*").map do |code|
          char = [code].pack("U")
          leading &&= [9, 12, 32].include?(code) unless key
          if separators && "=:".include?(char) && code < 128 then "\\#{char}"
          elsif code > 31 && code < 127
            char == " " && (key || leading) ? "\\ " : char == "\\" ? "\\\\" : char
          elsif (named = { 9 => "\\t", 10 => "\\n", 12 => "\\f", 13 => "\\r" }[code]) then named
          elsif code < 160 || code >= 256 then format("\\u%04x", code)
          else char
          end
        end.join
      end

      # --- one execution, as the TypeScript engine maps it ---

      def map_steps(record, scenario, document, pickle, warn)
        mapped = [] #: Array[Hash[Symbol, untyped]]
        record[:steps].each_with_index do |entry, index|
          id = entry[:step_record_id]
          step_record = id && scenario.step_records[id]
          unreadable = id && scenario.step_records.key?(id) && step_record.nil?
          previous = mapped.last&.dig(:step, :stop) || ms(record[:started_at])
          begin
            mapped << map_step(index, entry, step_record, unreadable, previous, document, pickle)
          rescue StandardError => e
            warn.("allure: step #{index} of scenario #{record[:scenario_record_id]} was not mapped: #{e.message}")
            span = own_span(step_record)
            mapped << { step: { name: entry[:text], status: "broken", message: e.message, start: span&.first || previous, stop: span&.last || previous,
                                attachments: [], parameters: [], child_steps: [] }, span: span, labels: [], links: [] }
          end
        end
        mapped
      end

      def own_span(step_record) = step_record && [ms(step_record["started_at"]), ms(step_record["finished_at"])]

      def scenarios_of(document)
        (document.dig("feature", "children") || []).flat_map do |child|
          [child["scenario"], *(child.dig("rule", "children") || []).map { _1["scenario"] }].compact
        end
      end

      def gherkin_steps(document)
        (document.dig("feature", "children") || []).flat_map do |child|
          [child, *(child.dig("rule", "children") || [])].flat_map { [*(_1.dig("background", "steps") || []), *(_1.dig("scenario", "steps") || [])] }
        end.to_h { [_1["id"], _1] }
      end

      def step_name(document, pickle, index, text)
        id = pickle.dig("steps", index, "astNodeIds", 0)
        keyword = id && gherkin_steps(document)[id]&.dig("keyword")
        keyword ? "#{keyword}#{text}" : text
      end

      def example_row(document, pickle)
        rows = scenarios_of(document).flat_map { |scenario| (scenario["examples"] || []).flat_map { |examples| (examples["tableBody"] || []).map { [_1["id"], [examples, _1]] } } }.to_h
        pickle["astNodeIds"].to_a.lazy.map { rows[_1] }.find(&:itself)
      end

      def csv_row(cells) = cells.map { (value = _1["value"].to_s).match?(/[",\r\n]/) ? %("#{value.gsub('"', '""')}") : value }.join(",")

      def buffer(name, type, content, extension) = { name: name, type: type, content: content, extension: extension }

      def path_attachment(name, type, path) = { name: name, type: type, path: path }

      def join_relative(dir, file) = "#{dir.to_s.sub(%r{/+\z}, "")}/#{file}"

      def content_type(file) = (dot = file.rindex(".")) ? MEDIA_TYPE_BY_EXTENSION.fetch(file[dot..].downcase, "application/octet-stream") : "application/octet-stream"

      # Attachments, log lines, links, labels, and parameters a step or a
      # hook declared, the same shape either way.
      def map_declared(declared, dir, at)
        return { attachments: [], child_steps: [], links: [], labels: [], parameters: [] } unless declared

        { attachments: (declared["attachments"] || []).map { path_attachment("declared: #{_1}", content_type(_1), join_relative(dir, _1)) },
          child_steps: (declared["logs"] || []).map { { name: _1, start: at, stop: at, status: "passed" } },
          links: (declared["links"] || []).map { { url: _1["url"], name: _1["name"], type: _1["type"] }.compact },
          labels: (declared["labels"] || []).map { { name: _1["name"], value: _1["value"] } },
          parameters: (declared["parameters"] || []).map { { name: _1["name"], value: _1["value"] } } }
      end

      def step_outcome(entry, step_record, unreadable)
        if unreadable
          return { status: "broken", message: "step record #{entry[:step_record_id]} could not be read; run.json records this step as #{entry[:status]}" }
        end

        case entry[:status]
        when "passed" then { status: "passed" }
        when "skipped" then { status: "skipped" }
        # A vocabulary defect has no step record to carry a kind.
        when "undefined", "ambiguous" then { status: "broken", message: entry.dig(:error, :message) }
        else
          if step_record && step_record["status"] == "failed"
            kind = step_record.dig("error", "kind")
            raw = step_record.dig("error", "message")
            { status: status_for_kind(kind), message: "#{failure_marker(kind)} #{raw}", raw: raw, kind: kind }
          else
            { status: "failed", message: entry.dig(:error, :message) }
          end
        end
      end

      def hook_outcome(hook)
        return { status: "passed" } if hook[:status] == "passed"
        return { status: "broken" } unless hook[:error]

        kind = hook[:error][:kind]
        { status: status_for_kind(kind), message: "#{failure_marker(kind)} #{hook[:error][:message]}", raw: hook[:error][:message], kind: kind }
      end

      def action_name(action)
        target = action["selector"] || action["url"]
        if action["method"] == "expect" && action["expression"]
          matcher = action["is_not"] == true ? "not #{action["expression"]}" : action["expression"]
          return target ? "expect #{target} #{matcher}" : "expect #{matcher}"
        end
        target ? "#{action["method"]} #{target}" : action["method"]
      end

      # Sections, polls, and actions as one timeline in the order they
      # began; on one instant, sections, then polls, then actions.
      def timeline(source, anchor)
        entries = [] #: Array[[String, Hash[Symbol, untyped]]]
        (source["sections"] || []).each { entries << [_1["at"], { name: _1["label"], start: ms(_1["at"]), stop: ms(_1["at"]), status: "passed" }] }
        (source["polls"] || []).each do |poll|
          start = ms(poll["at"])
          status = { "resolved" => "passed", "timed_out" => "failed" }.fetch(poll["outcome"], "broken")
          entries << [poll["at"], { name: "#{poll["description"] || "poll"} (#{poll["attempts"]} attempts)", start: start, stop: start + poll["waited_ms"].to_i, status: status }]
        end
        (source["actions"] || []).each do |action|
          start = ms(action["at"])
          entries << [action["at"], { name: action_name(action), start: start, stop: start + action["ms"].to_i, status: action["outcome"] == "failed" ? "failed" : "passed" }]
        end
        steps = entries.each_with_index.sort_by { |(at, _), index| [at, index] }.map { _1.first.last }
        if (total = source.dig("truncated", "actions"))
          last = steps.last&.dig(:stop) || anchor
          steps << { name: "... #{total - (source["actions"] || []).size} more actions not shown", start: last, stop: last, status: "passed" }
        end
        steps
      end

      def page_event_count(entries, total)
        return nil if entries.nil? || entries.empty?

        total ? "#{entries.size} of #{total}" : entries.size.to_s
      end

      def calls(entries)
        (entries || []).map do |entry|
          { name: entry["step"], start: ms(entry["started_at"]), stop: ms(entry["finished_at"]),
            status: entry["error"] ? status_for_kind(entry.dig("error", "kind")) : "passed",
            parameters: [{ name: "args", value: js_json(entry["args"]) }, *(entry.key?("result") ? [{ name: "result", value: js_json(entry["result"]) }] : [])],
            child_steps: calls(entry["calls"]) }
        end
      end

      def channel(measured) = measured.nil? ? "none" : "#{measured["step_record_id"]} #{measured["channel"]}"

      # A judged-as claim compared nothing: a judgment decides it outside
      # the results, and skipped is the one status that claims neither.
      def claim_status(outcome)
        { "for-judgment" => "skipped", "held" => "passed", "broken" => "failed" }.fetch(outcome, "broken")
      end

      def claim_parameters(claim)
        parameters = [] #: Array[Hash[Symbol, untyped]]
        parameters << { name: "actual", value: js_json(claim["actual"]) } if claim.key?("actual") && !claim["actual"].nil?
        parameters << { name: "actual from", value: claim["actual_from"] }
        parameters << { name: "expected", value: js_json(claim["expected"]) } if claim.key?("expected") && !claim["expected"].nil?
        parameters << { name: "expected from", value: claim["expected_from"] } if claim.key?("expected_from")
        return parameters if claim["outcome"] == "unobserved"

        parameters << { name: "measured", value: channel(claim["measured"]) }
        unless claim.key?("each")
          parameters << { name: "expected measured", value: channel(claim["expected_measured"]) } if claim.key?("expected_measured")
          return parameters
        end
        declared = [*(claim.dig("each", "where") || []).each_with_index.map { ["where[#{_2}]", _1] },
                    *(claim.dig("each", "claims") || []).each_with_index.map { ["claims[#{_2}]", _1] }]
        declared.each { |name, entry| parameters << { name: "expected measured #{name}", value: channel(entry["expected_measured"]) } if entry.key?("expected_measured") }
        parameters
      end

      def map_claims(claims, at)
        (claims || []).map do |claim|
          { name: ClaimLine.line(JSON.parse(JSON.generate(claim), symbolize_names: true)), start: at, stop: at,
            status: claim_status(claim["outcome"]), parameters: claim_parameters(claim) }
        end
      end

      # JSON as JavaScript writes it: a whole-number float has no fraction.
      def js_json(value) = JSON.generate(js_value(value))

      def js_value(value)
        case value
        when Float then value.finite? && value == value.floor && value.abs < 1e21 ? value.to_i : value
        when Array then value.map { js_value(_1) }
        when Hash then value.transform_values { js_value(_1) }
        else value
        end
      end

      def judged_view_attachments(view)
        pages = view&.dig("pages") || []
        pages.flat_map do |page|
          which = pages.size == 1 ? "" : " (page #{page["page"]}#{page["as"].nil? ? "" : " of #{page["as"]}"})"
          [*(page["screenshot"] ? [["judged view#{which}", page.dig("screenshot", "file"), "image/png"]] : []),
           *(page["aria"] ? [["judged view ARIA#{which}", page.dig("aria", "file"), "text/plain"]] : [])]
        end
      end

      def map_step(index, entry, step_record, unreadable, previous, document, pickle)
        outcome = step_outcome(entry, step_record, unreadable)
        span = own_span(step_record)
        start, stop = span || [previous, previous]
        attachments = [] #: Array[Hash[Symbol, untyped]]
        argument = pickle.dig("steps", index, "argument")
        rows = argument&.dig("dataTable", "rows")
        attachments << buffer("Data table", "text/csv", "#{rows.map { csv_row(_1["cells"]) }.join("\n")}\n", ".csv") if rows && !rows.empty?
        attachments << buffer("Doc string", "text/plain", argument.dig("docString", "content"), ".txt") if argument&.dig("docString")
        parameters = [] #: Array[Hash[Symbol, untyped]]
        declared = map_declared(nil, nil, nil)
        children = [] #: Array[Hash[Symbol, untyped]]
        if step_record
          evidence = step_record["evidence"] || {}
          dir = evidence["dir"]
          mutates = step_record["mutates"]
          parameters << { name: "step record id", value: step_record["step_record_id"] }
          parameters << { name: "mutates (declared)", value: mutates.nil? ? "not declared" : mutates.to_s }
          if (world = step_record["world"])
            parameters << { name: "world reads (observed)", value: world["reads"].join(", ") }
            parameters << { name: "world writes (observed)", value: world["writes"].join(", ") }
          end
          used = step_record["used"] || []
          parameters << { name: "used step records", value: used.map { _1["step_record_id"] }.join(", ") } unless used.empty?
          required = step_record["required_env"] || []
          parameters << { name: "required env", value: required.join(", ") } unless required.empty?
          if (events = step_record["page_events"])
            { "console_errors" => "console errors (observed)", "page_errors" => "page errors (observed)", "failed_requests" => "failed requests (observed)" }.each do |key, name|
              count = page_event_count(events[key], events.dig("truncated", key))
              parameters << { name: name, value: count } if count
            end
          end
          attachments << buffer("record.json", "application/json", JSON.pretty_generate(js_value(step_record)), ".json")
          if step_record["status"] == "passed" && !step_record["result"].nil?
            attachments << buffer("result", "application/json", JSON.pretty_generate(js_value(step_record["result"])), ".json")
          end
          { "http" => "http log", "mcp" => "mcp log", "websocket" => "websocket log" }.each do |key, name|
            attachments << path_attachment(name, "text/plain", join_relative(dir, evidence[key])) if evidence[key]
          end
          attachments << path_attachment("trace", TRACE, join_relative(dir, evidence["trace"])) if evidence["trace"]
          (evidence["named_traces"] || []).each { attachments << path_attachment("trace (#{_1["as"]})", TRACE, join_relative(dir, _1["file"])) }
          (evidence["screenshots"] || []).each { attachments << path_attachment(_1["file"], "image/png", join_relative(dir, _1["file"])) }
          judged_view_attachments(step_record["judged_view"]).each { |name, file, type| attachments << path_attachment(name, type, join_relative(dir, file)) }
          (evidence["attachments"] || []).each { attachments << path_attachment(_1["name"], content_type(_1["file"]), join_relative(dir, _1["file"])) }
          declared = map_declared(step_record["declared"], dir, start)
          attachments.concat(declared[:attachments])
          parameters.concat(declared[:parameters])
          children = [*declared[:child_steps], *timeline(step_record, ms(step_record["started_at"])), *calls(step_record["calls"]),
                      *map_claims(step_record["claims"], stop)]
        end
        { step: { name: step_name(document, pickle, index, entry[:text]), status: outcome[:status], message: outcome[:message],
                  start: start, stop: stop, attachments: attachments, parameters: parameters, child_steps: children },
          span: span, labels: declared[:labels], links: declared[:links],
          failure: outcome[:kind] && outcome[:message] ? { kind: outcome[:kind], message: outcome[:message], raw: outcome[:raw] || outcome[:message] } : nil,
          unreadable: unreadable ? true : nil }
      end

      # The first classified failure, a step's before a hook's.
      #: (Array[Hash[Symbol, untyped]], Array[untyped]) -> Hash[Symbol, untyped]?
      def first_failure(steps, hooks)
        steps.each { return _1[:failure] if _1[:failure] }
        hooks.each do |hook|
          outcome = hook_outcome(hook)
          return { kind: outcome[:kind], message: outcome[:message], raw: outcome[:raw] || outcome[:message] } if outcome[:kind] && outcome[:message]
        end
        nil
      end

      def tag_labels(pickle)
        (pickle["tags"] || []).map do |tag|
          name = tag["name"]
          if (id = ALLURE_ID_TAG.match(name)) then { name: "ALLURE_ID", value: id[1] }
          elsif (label = ALLURE_LABEL_TAG.match(name)) then { name: label[1], value: label[2] }
          else { name: "tag", value: name }
          end
        end
      end

      def map_scenario(record, document, pickle, posix, project, steps, verdict)
        scenario = scenarios_of(document).find { pickle["astNodeIds"].to_a.include?(_1["id"]) }
        feature_name = document.dig("feature", "name") || ""
        start = ms(record[:started_at])
        stop = ms(record[:finished_at])
        failure = record[:status] == "failed" ? first_failure(steps, record[:hooks]) : nil
        unreadable = steps.find { _1[:unreadable] }
        row = example_row(document, pickle)
        labels = [{ name: "feature", value: feature_name }, { name: "package", value: [*project, *posix.split("/")].join(".") }, *tag_labels(pickle),
                  { name: "env", value: record[:environment] }, *(verdict ? [{ name: "role", value: verdict[:role] }] : []),
                  *steps.flat_map { _1[:labels] }, *(failure ? [{ name: "nukadoko.failure", value: failure[:kind] }] : [])]
        attachments = [] #: Array[Hash[Symbol, untyped]]
        if row
          examples = row.first
          header = csv_row(examples.dig("tableHeader", "cells") || [])
          body = (examples["tableBody"] || []).map { csv_row(_1["cells"]) }.join("\n")
          attachments << buffer("Examples", "text/csv", "#{header}\n#{body}\n", ".csv") unless header.empty? && body.empty?
        end
        (record.dig(:evidence, :screenshots) || []).each { attachments << path_attachment(_1[:file], "image/png", join_relative(record[:evidence][:dir], _1[:file])) }
        headers = row ? (row.first.dig("tableHeader", "cells") || []).map { _1["value"] } : []
        examples = row ? row.last["cells"].each_with_index.map { |cell, index| { name: headers[index] || "arg#{index}", value: cell["value"] } } : []
        context = [*(record[:target_version] ? [{ name: "target_version", value: record[:target_version], excluded: true }] : []),
                   *(verdict ? [{ name: "verdict", value: verdict[:verdict], excluded: true }] : [])]
        identity = [{ name: "nukadoko.scenario.steps", value: pickle["steps"].map { _1["text"] }.join("\n"), mode: "hidden" },
                    { name: "environment", value: record[:environment] }]
        description = [scenario&.dig("description"), document.dig("feature", "description")].map { _1.to_s.strip }.find { !_1.empty? }
        stopped = record[:stopped]
        message = failure&.dig(:message) ||
                  (if record[:status] == "passed" then unreadable&.dig(:step, :message)
                   elsif record[:status] == "stopped" && stopped
                     "the walk (nuka run --step) was stopped after step #{stopped[:after_step]} with nuka step stop, so the steps after it did not run"
                   end)
        previous = start
        placed_steps = steps.map do |outcome|
          from, to = outcome[:span] || [previous, previous]
          previous = to
          { **outcome[:step], start: from, stop: to }
        end
        status = if record[:status] == "stopped" then "skipped"
                 elsif record[:status] == "passed" && unreadable then "broken"
                 else record[:status]
                 end
        { name: verdict&.dig(:role) == "control" ? "#{pickle["name"]} (control)" : pickle["name"], feature_name: feature_name, description: description,
          status: status, message: message, trace: failure&.dig(:raw), start: start, stop: stop, labels: labels,
          links: steps.flat_map { _1[:links] }.uniq { [_1[:url], _1[:name], _1[:type]] }, parameters: [*examples, *context, *identity],
          attachments: attachments, steps: placed_steps }
      end

      # A hook record holds no time of its own: a before hook sits at the
      # scenario's start and an after hook at its end, both zero-width.
      def map_hooks(record, start, stop)
        record[:hooks].map do |hook|
          hook = JSON.parse(JSON.generate(hook))
          symbol = hook.transform_keys(&:to_sym)
          symbol[:error] = symbol[:error]&.transform_keys(&:to_sym)
          outcome = hook_outcome(symbol)
          at = hook["type"] == "before" ? start : stop
          declared = map_declared(hook["declared"], record[:evidence][:dir], at)
          fallback = { "before" => "Before", "after" => "After" }.fetch(hook["type"]) { "AfterStep[#{hook["step_index"]}]" }
          attachments = [*declared[:attachments]]
          attachments << path_attachment("trace", TRACE, join_relative(record[:evidence][:dir], hook["trace"])) if hook["trace"]
          (hook["named_traces"] || []).each { attachments << path_attachment("trace (#{_1["as"]})", TRACE, join_relative(record[:evidence][:dir], _1["file"])) }
          { type: hook["type"] == "before" ? "before" : "after", name: hook["name"].to_s.empty? ? fallback : hook["name"], status: outcome[:status],
            message: outcome[:message], start: at, stop: at, attachments: attachments,
            child_steps: [*declared[:child_steps], *timeline(hook, at)], declared_parameters: declared[:parameters] }
        end
      end
    end
  end
end
