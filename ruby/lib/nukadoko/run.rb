# frozen_string_literal: true

require "socket"
require "securerandom"
require "fileutils"
require "time"

# One run: start the program, play each scenario's steps in order, write a
# record per step and a summary per run. A scenario stops at its first failed
# step and skips the rest, as the TypeScript engine does.
module Nukadoko
  module Engine
    class Run
      def initialize(project, steps, scenarios, program, out: $stdout)
        @project = project
        @steps = steps
        @scenarios = scenarios
        @program = program
        @out = out
        @id = "run-#{Time.now.utc.strftime("%Y%m%d-%H%M%S")}-#{SecureRandom.alphanumeric(4).downcase}"
        @dir = File.join(project, ".nukadoko", "runs", @id)
      end

      def call
        FileUtils.mkdir_p(File.join(@dir, "steps"))
        with_program do |base_url|
          @base_url = base_url
          @browser = Browser.new(base_url, Nukadoko.config_options.fetch(:browser, {}))
          results = @scenarios.each_with_index.map { |scenario, i| play(scenario, i) }
          @browser.close
          write_summary(results)
          passed = results.count { _1[:status] == "passed" }
          @out.puts "summary   #{File.join(".nukadoko/runs", @id, "summary.md")}"
          @out.puts "#{results.size} scenarios: #{passed} passed, #{results.size - passed} failed"
          { run_id: @id, run_dir: File.join(".nukadoko/runs", @id), scenarios: results.map { scenario_json(_1) } }
        end
      end

      private

      def play(scenario, index)
        @out.puts "scenario #{index + 1}/#{@scenarios.size}  #{scenario.uri}:#{scenario.line}  #{scenario.name}"
        failed = nil
        records = scenario.steps.each_with_index.map do |line, i|
          record = failed ? { step: Engine.matches(@steps, line.text).first&.first&.step_name, text: line.text, status: "skipped" } : play_step(line)
          failed ||= record[:error] if record[:status] == "failed"
          @out.puts "  step #{i + 1}/#{scenario.steps.size}  #{record[:status]}  #{line.text}"
          @out.puts "      #{record[:error]}" if record[:error]
          record
        end
        @browser.end_scenario
        { scenario: scenario, status: failed ? "failed" : "passed", steps: records }
      end

      def play_step(line)
        step, captures = Engine.matches(@steps, line.text).first
        args = captures.dup
        missing = step.args.fields.map { _1.name.to_s } - args.keys
        args[missing.first] = line.table if line.table && missing.any?
        id = "step-#{Time.now.utc.strftime("%Y%m%d-%H%M%S")}-#{SecureRandom.alphanumeric(4).downcase}"
        dir = File.join(@dir, "steps", id)
        FileUtils.mkdir_p(dir)
        log = []
        fixtures, finish = build_fixtures(step, dir, log)
        started = Time.now.utc
        record = { step_record_id: id, step: step.step_name, text: line.text, args: args, started_at: started.iso8601(3) }
        begin
          check_values!(step.args, args, "args")
          value = step.new.public_send(step.body, **fixtures, args: step.inputs.load(args))
          if step.claims
            judged = Claims.judge(step.claims, value.transform_keys(&:to_s), args)
            record[:claims] = judged
            record[:status] = judged.all? { _1[:holds] } ? "passed" : "failed"
            record[:error] = "a claim did not hold" if record[:status] == "failed"
          else
            check_values!(step.returns, value, "returns") if step.returns
            record[:result] = value
            record[:status] = "passed"
          end
        rescue StandardError => e
          record[:status] = "failed"
          record[:error] = "#{e.class}: #{e.message}"
        ensure
          finish&.call
          log.concat(fixtures[:request].log) if fixtures[:request]
          record[:finished_at] = Time.now.utc.iso8601(3)
          record[:observed] = { http: log.size }
          File.write(File.join(dir, "http.jsonl"), log.map { JSON.generate(_1) }.join("\n"))
          File.write(File.join(dir, "record.json"), JSON.pretty_generate(record))
        end
        record
      end

      def build_fixtures(step, dir, log)
        finish = nil
        fixtures = step.fixtures.to_h do |name|
          case name
          when :request then [name, Request.new(@base_url)]
          when :page
            page, finish = @browser.page_for(dir, log)
            [name, page]
          else raise ArgumentError, "fixture #{name} is not in this prototype"
          end
        end
        [fixtures, finish]
      end

      # The same rule zod applies on the TypeScript side: every declared key
      # is present with its declared type, and nothing else.
      def check_values!(schema, value, label)
        hash = value.transform_keys(&:to_s)
        extra = hash.keys - schema.fields.map { _1.name.to_s }
        raise TypeError, "#{label} has keys the schema does not declare: #{extra.join(", ")}" if extra.any?

        schema.fields.each do |field|
          v = hash.fetch(field.name.to_s) { raise TypeError, "#{label}.#{field.name} is missing" }
          ok = case field.type
               when :string then v.is_a?(String)
               when :boolean then v == true || v == false
               when :integer then v.is_a?(Integer)
               when :number then v.is_a?(Numeric)
               when :array then v.is_a?(Array)
               end
          raise TypeError, "#{label}.#{field.name} must be #{field.type}, got #{v.inspect}" unless ok
        end
      end

      def with_program
        return yield(@program[:base_url]) unless @program[:serve]

        port = TCPServer.open("127.0.0.1", 0) { _1.addr[1] }
        command = @program[:serve][:command].gsub("{port}", port.to_s)
        log = File.open(File.join(@dir, "program.log"), "w")
        pid = Process.spawn(command, chdir: @project, out: log, err: log, pgroup: true)
        base = "http://127.0.0.1:#{port}"
        wait_ready(URI.join(base, @program[:serve][:ready]))
        yield base
      ensure
        Process.kill("TERM", -pid) if pid
        log&.close
      end

      def wait_ready(uri)
        deadline = Time.now + 30
        loop do
          return if Net::HTTP.get_response(uri).code.to_i < 500
        rescue SystemCallError
          raise "program did not answer #{uri} within 30s" if Time.now > deadline

          sleep 0.1
        end
      end

      def scenario_json(result)
        scenario = result[:scenario]
        {
          feature: scenario.uri, line: scenario.line, scenario: scenario.name, status: result[:status],
          steps: scenario.steps.zip(result[:steps]).map do |line, record|
            { line: line.line, text: line.text, step: record[:step], status: record[:status], record: record[:step_record_id] }.compact
          end
        }
      end

      def write_summary(results)
        lines = ["# Run #{@id}", ""]
        results.each do |r|
          lines << "- #{r[:status]}  #{r[:scenario].uri}:#{r[:scenario].line}  #{r[:scenario].name}"
        end
        File.write(File.join(@dir, "summary.md"), lines.join("\n") + "\n")
      end
    end
  end
end
