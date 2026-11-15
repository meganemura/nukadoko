# frozen_string_literal: true
# rbs_inline: enabled

require "json"
require "gherkin"

# One run directory read back into what the report writers take, as the
# TypeScript engine's src/report/load-run.ts reads it: each feature the run
# parsed, from sources.json, and each head execution of run.json with its
# step records, its pickle, and what the verdict table says of it. It reads
# only the run directory, so a directory copied off a CI machine renders
# the same as one in the project that ran it.
#
# A run directory copied off a machine is untrusted input: an edited
# record can name any path, so every path a record names is resolved,
# symlinks included, and refused unless it stays inside the run directory.
# A refused path is a problem the report names, never a file it reads.
#
# The pickles are parsed again from sources.json, so their ids differ from
# the run's; no output keeps a pickle id across renders.
module Nukadoko
  module Engine
    class ReportRun
      Feature = Data.define(
        :path, #: String
        :source, #: String
        :document, #: Hash[String, untyped]
        :pickles, #: Array[Hash[String, untyped]]
      )

      Scenario = Data.define(
        :json, #: Hash[Symbol, untyped]
        :step_records, #: Hash[String, Hash[String, untyped]?]
        :feature, #: Feature
        :pickle, #: Hash[String, untyped]
        :verdict, #: Hash[Symbol, untyped]?
      )

      attr_reader :dir #: String
      attr_reader :document #: Hash[Symbol, untyped]
      attr_reader :project_name #: String?
      attr_reader :features #: Array[Feature]
      attr_reader :scenarios #: Array[Scenario]
      attr_reader :problems #: Array[String]

      # The run in `dir`, or a Refusal that says why it cannot be read.
      #: (String) -> void
      def initialize(dir)
        @dir = dir
        @root = File.realpath(dir)
        run_json = File.join(dir, "run.json")
        raise Refusal.new("run-not-found", "#{dir} holds no run.json that nuka run wrote") unless File.file?(run_json)
        raise Refusal.new("run-invalid", "#{run_json} resolves outside the run directory, so it is not read") unless inside?(run_json)

        @document = begin
          JSON.parse(File.read(run_json, encoding: "UTF-8"), symbolize_names: true)
        rescue JSON::ParserError => e
          raise Refusal.new("run-invalid", "#{run_json} does not parse as JSON: #{e.message.lines.first.to_s.chomp}")
        end
        @problems = []
        @project_name = nil
        @features = read_features
        @scenarios = read_scenarios
      end

      # Where a path inside the run directory is on disk; raises for one
      # that resolves outside it.
      #: (String) -> String
      def resolve(relative)
        file = File.join(@dir, relative)
        raise ArgumentError, "#{relative} resolves outside the run directory, so it is not read" unless inside?(file)

        file
      end

      private

      def inside?(file)
        real = File.exist?(file) ? File.realpath(file) : File.expand_path(file)
        real == @root || real.start_with?("#{@root}/")
      end

      def read_features
        sources = File.join(@dir, "sources.json")
        id = @document[:run_id]
        unless inside?(sources)
          raise Refusal.new("run-sources-invalid", "#{@dir} holds a sources.json that resolves outside the run directory, so the scenarios of run #{id} cannot be parsed")
        end
        raise Refusal.new("run-sources-missing", "#{@dir} holds no sources.json, so the scenarios of run #{id} cannot be parsed") unless File.file?(sources)

        parsed = begin
          JSON.parse(File.read(sources, encoding: "UTF-8"))
        rescue JSON::ParserError => e
          raise Refusal.new("run-sources-invalid", "#{@dir} holds a sources.json that does not parse as JSON: #{e.message.lines.first.to_s.chomp}, so the scenarios of run #{id} cannot be parsed")
        end
        list = (parsed["features"] if parsed.is_a?(Hash)) #: untyped
        unless list.is_a?(Array) && list.all? { _1.is_a?(Hash) && _1["path"].is_a?(String) && _1["source"].is_a?(String) }
          raise Refusal.new("run-sources-invalid", "#{@dir} holds a sources.json that lacks a field, so the scenarios of run #{id} cannot be parsed")
        end

        @project_name = parsed["project"].is_a?(String) ? parsed["project"] : nil
        list.filter_map do |entry|
          gherkin = Gherkin #: untyped
          envelopes = gherkin.from_source(entry["path"], entry["source"], include_source: false, include_gherkin_document: true, include_pickles: true).to_a
          error = envelopes.find(&:parse_error)
          next @problems << "#{entry["path"]} in sources.json does not parse: #{error.parse_error.message}" if error

          document = JSON.parse(envelopes.find(&:gherkin_document).gherkin_document.to_json)
          Feature.new(path: entry["path"], source: entry["source"], document: document,
                      pickles: envelopes.select(&:pickle).map { JSON.parse(_1.pickle.to_json) })
        end
      end

      # An execution of the base or the old world is a cell of the table,
      # not a test result, so the formats render head's executions alone.
      def read_scenarios
        pickles = @features.flat_map { |feature| feature.pickles.map { [[feature.path, _1.dig("location", "line")], [feature, _1]] } }.to_h
        @document[:scenarios].filter_map do |scenario|
          next if scenario[:world]

          feature, pickle = pickles[[scenario[:feature], scenario[:line]]]
          unless feature && pickle
            next @problems << "#{scenario[:feature]}:#{scenario[:line]} (#{scenario[:scenario_record_id]}) matches no scenario in sources.json"
          end

          records = {} #: Hash[String, Hash[String, untyped]?]
          scenario[:steps].each do |step|
            id = step[:step_record_id]
            next if id.nil? || step[:record].nil? || records.key?(id)

            records[id] = begin
              JSON.parse(File.read(resolve(File.join(step[:record], "record.json")), encoding: "UTF-8"))
            rescue StandardError => e
              @problems << (e.is_a?(ArgumentError) ? "#{scenario[:scenario_record_id]}: #{e.message}" : "#{step[:record]}/record.json of #{scenario[:scenario_record_id]} could not be read")
              nil
            end
          end
          Scenario.new(json: scenario, step_records: records, feature: feature, pickle: pickle, verdict: verdict_of(scenario))
        end
      end

      # What the verdict table says of an execution's row and cell.
      def verdict_of(scenario)
        row = @document.dig(:table, :rows)&.find { _1[:feature] == scenario[:feature] && _1[:line] == scenario[:line] }
        cell = row && row[:cells].find { _1[:world] == "head" && _1[:environment] == scenario[:environment] }
        row && cell ? { verdict: row[:verdict], reason: row[:reason], role: cell[:role] } : nil
      end
    end
  end
end
