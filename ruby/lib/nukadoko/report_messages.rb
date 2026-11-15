# frozen_string_literal: true
# rbs_inline: enabled

require "json"
require "rbconfig"
require "securerandom"

# One run as a cucumber-messages stream, for `nuka report --format
# messages`, in the shape the TypeScript engine writes it
# (src/report/messages/): one line per envelope, in the protocol's order.
# It is compat fidelity only, so a migrated team's formatter, JUnit step,
# or HTML report keeps working: step record internals never appear in the
# protocol's closed messages. A claim step's claims ride as an attachment
# of their own media type, and what the verdict table says of an
# execution as a test case attachment, since the protocol has no field
# for either.
#
# The stream leaves out every control execution: a JUnit-reading CI gates
# on it, and a control that failed is the proof a green run rests on,
# which as a test case would read as a failure.
#
# Each execution is its own test case, attempt 0: `--repeat` executions
# all count, and a retry's shape would let a reader fold a red first
# execution into a green last one. A run over more than one environment
# gives each (pickle, environment) a pickle of its own, named with the
# environment, since the protocol has no field for where a case ran.
module Nukadoko
  module Engine
    module ReportMessages
      CLAIMS_MEDIA_TYPE = "application/vnd.nukadoko.claims+json"
      VERDICT_MEDIA_TYPE = "application/vnd.nukadoko.verdict+json"
      CLAIM_BROKEN_EXCEPTION = "nukadoko.ClaimBroken"
      STATUS = { "passed" => "PASSED", "failed" => "FAILED", "skipped" => "SKIPPED", "undefined" => "UNDEFINED", "ambiguous" => "AMBIGUOUS" }.freeze
      CLAIM_FIELDS = %w[readings readings_left_out settled pages page_requests judged_view].freeze

      module_function

      # The stream's text, and the problems that left part of the run out.
      #: (ReportRun) -> String
      def render(run)
        lines = [] #: Array[String]
        append = ->(envelope) { lines << "#{JSON.generate(envelope)}\n" }
        document = run.document
        gating = run.scenarios.reject { _1.verdict&.dig(:role) == "control" }
        append.({ meta: meta(document[:nukadoko].to_s) })
        copies = environment_pickles(gating)
        run.features.each do |feature|
          uri = feature.document["uri"] || feature.path
          append.({ source: { uri: uri, data: feature.source, mediaType: "text/x.cucumber.gherkin+plain" } })
          append.({ gherkinDocument: { **feature.document, "uri" => uri } })
          selected = gating.select { _1.feature.equal?(feature) }.map(&:pickle)
          feature.pickles.select { |pickle| selected.any? { _1.equal?(pickle) } }.each do |pickle|
            (copies[pickle.object_id]&.values || [pickle]).each { append.({ pickle: { **_1, "uri" => uri } }) }
          end
        end
        append.({ testRunStarted: { timestamp: timestamp(document[:started_at]) } })
        gating.each do |scenario|
          pickle = copies.dig(scenario.pickle.object_id, scenario.json[:environment]) || scenario.pickle
          test_case(scenario, pickle, append)
        end
        append.({ testRunFinished: { success: document[:verdict] == "passed", timestamp: timestamp(document[:finished_at]) } })
        lines.join
      end

      #: (String) -> Hash[Symbol, untyped]
      def meta(version)
        os = RbConfig::CONFIG["host_os"].to_s
        cpu = RbConfig::CONFIG["host_cpu"].to_s
        spec = Gem.loaded_specs["cucumber-messages"] #: untyped
        { protocolVersion: spec&.version.to_s,
          # The version that ran the scenarios, as run.json records it.
          implementation: { name: "nukadoko", version: version },
          runtime: { name: "ruby", version: RUBY_VERSION },
          os: { name: os.include?("darwin") ? "darwin" : os.match?(/mswin|mingw/) ? "win32" : os.include?("linux") ? "linux" : os },
          cpu: { name: { "x86_64" => "x64", "aarch64" => "arm64" }.fetch(cpu, cpu) } }
      end

      #: (Array[ReportRun::Scenario]) -> Hash[Integer, Hash[String, Hash[String, untyped]]]
      def environment_pickles(scenarios)
        return {} if scenarios.map { _1.json[:environment] }.uniq.size <= 1

        copies = {} #: Hash[Integer, Hash[String, Hash[String, untyped]]]
        scenarios.each do |scenario|
          per = (copies[scenario.pickle.object_id] ||= {})
          environment = scenario.json[:environment]
          next if per.key?(environment)

          pickle = scenario.pickle
          per[environment] = { **pickle, "id" => SecureRandom.uuid, "name" => "#{pickle["name"]} (#{environment})",
                               "steps" => pickle["steps"].map { { **_1, "id" => SecureRandom.uuid } } }
        end
        copies
      end

      #: (untyped) -> Integer
      def ms_of(time) = (Time.iso8601(time.to_s).to_r * 1000).floor

      #: (untyped) -> Hash[Symbol, Integer]
      def timestamp(time) = stamp(ms_of(time))

      #: (Integer) -> Hash[Symbol, Integer]
      def stamp(ms) = { seconds: ms.div(1000), nanos: (ms % 1000) * 1_000_000 }

      #: (ReportRun::Scenario, Hash[String, untyped], ^(Hash[Symbol, untyped]) -> void) -> void
      def test_case(scenario, pickle, append)
        json = scenario.json
        start = ms_of(json[:started_at])
        stop = ms_of(json[:finished_at])
        case_id = SecureRandom.uuid
        started_id = SecureRandom.uuid
        previous = start
        steps = json[:steps].each_with_index.map do |step, index|
          id = step[:step_record_id]
          record = id && scenario.step_records[id]
          unreadable = id && scenario.step_records.key?(id) && record.nil?
          # A step with no record of its own is zero-width at the end of
          # the step before it.
          from, to = record ? [ms_of(record["started_at"]), ms_of(record["finished_at"])] : [previous, previous]
          previous = to
          step_id = SecureRandom.uuid
          message = step.dig(:error, :message)
          result = if unreadable
                     result(from, to, "UNKNOWN", "step record #{id} could not be read; run.json records this step as #{step[:status]}")
                   else
                     broken = record && record["status"] == "failed" && record.dig("error", "kind") == "claim_broken"
                     result(from, to, STATUS.fetch(step[:status].to_s, "UNKNOWN"), message, broken)
                   end
          { step: { id: step_id, **(pickle["steps"][index] ? { pickleStepId: pickle["steps"][index]["id"] } : {}) }, from: from, to: to, result: result,
            attachments: record ? claims_attachment(record, started_id, step_id) : [] }
        end
        append.({ testCase: { id: case_id, pickleId: pickle["id"], testSteps: steps.map { _1[:step] } } })
        append.({ testCaseStarted: { attempt: 0, id: started_id, testCaseId: case_id, timestamp: stamp(start) } })
        steps.each do |step|
          append.({ testStepStarted: { testCaseStartedId: started_id, testStepId: step[:step][:id], timestamp: stamp(step[:from]) } })
          step[:attachments].each { append.({ attachment: _1 }) }
          append.({ testStepFinished: { testCaseStartedId: started_id, testStepId: step[:step][:id], timestamp: stamp(step[:to]), testStepResult: step[:result] } })
        end
        if (verdict = scenario.verdict)
          append.({ attachment: { body: JSON.generate({ verdict: verdict[:verdict], reason: verdict[:reason] }), contentEncoding: "IDENTITY",
                                  mediaType: VERDICT_MEDIA_TYPE, fileName: "verdict.json", testCaseStartedId: started_id } })
        end
        append.({ testCaseFinished: { testCaseStartedId: started_id, timestamp: stamp(stop), willBeRetried: false } })
      end

      # `exception` is set for a broken claim only: its type is a fact
      # nukadoko decided, and any other failure carries a message alone.
      #: (Integer, Integer, String, String?, ?bool) -> Hash[Symbol, untyped]
      def result(from, to, status, message, broken = false)
        span = [to - from, 0].max
        { status: status, duration: stamp(span), **(message ? { message: message } : {}),
          **(broken && message ? { exception: { type: CLAIM_BROKEN_EXCEPTION, message: message } } : {}) }
      end

      # The readings go with the claims: a value that walked toward the
      # expected one across a poll is visible only in them.
      #: (Hash[String, untyped], String, String) -> Array[Hash[Symbol, untyped]]
      def claims_attachment(record, started_id, step_id)
        return [] unless record.key?("claims")

        body = { claims: record["claims"], **{ observation: record["observation"], attempts: record["attempts"] }.compact,
                 **CLAIM_FIELDS.to_h { [_1.to_sym, record[_1]] }.compact }
        [{ body: JSON.generate(body), contentEncoding: "IDENTITY", mediaType: CLAIMS_MEDIA_TYPE, fileName: "claims.json",
           testCaseStartedId: started_id, testStepId: step_id }]
      end
    end
  end
end
