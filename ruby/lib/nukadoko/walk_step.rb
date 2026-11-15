# frozen_string_literal: true
# rbs_inline: enabled

require "json"

# `nuka step wait`, `nuka step next <pause> --walk <n>`, and `nuka step stop
# <pause> --walk <n>`, the side of a walk that answers it, in the
# TypeScript engine's shape (src/cli/step.ts). This class reads its
# arguments and prints; WalkFiles reads and writes the walk's files, and
# Walk decides what a call does. Findings go to stderr outside --json, as
# the TypeScript engine prints them, so stdout holds only where the walk
# stands.
module Nukadoko
  class CLI
    class Walked
      ACTIONS = %w[wait next stop].freeze
      DEFAULT_TIMEOUT = 90

      #: (String, Array[String], Hash[String, Array[String]], json: bool, out: IO, ?err: IO) -> void
      def initialize(project, rest, options, json:, out:, err: $stderr)
        @project = project
        @action = rest[0]
        @pause = rest[1]
        @walk = options["--walk"]&.last
        @timeout = options["--timeout"]&.last
        @json = json
        @out = out
        @err = err
      end

      #: () -> Integer
      def call
        command = "step #{@action}"
        unless ACTIONS.include?(@action)
          return refuse(command, "invalid-arguments", "nuka step needs one of wait, next, or stop#{@action ? " (got #{@action})" : ""}", run: "nuka step wait")
        end

        call = call_of
        return refuse(command, "invalid-value", call[:refused], run: "nuka step wait") if call[:refused]

        timeout = @timeout.nil? ? DEFAULT_TIMEOUT : Float(@timeout, exception: false)
        if timeout.nil? || !timeout.finite? || timeout.negative?
          return refuse(command, "invalid-value", "--timeout must be a number of seconds, 0 or more (got #{@timeout}).")
        end

        result = Engine::WalkFiles.step_call(@project, call, timeout)
        if result[:kind] == "refuse"
          return refuse(command, result[:code], result[:message], run: result[:do], fields: result[:fields] || {})
        end

        report = result[:report]
        if @json
          @out.puts JSON.pretty_generate(envelope(command, report[:exit_code], report[:findings], report[:fields]))
        else
          @out.write(text(result[:seen], report[:fields]))
          report[:findings].each { print_finding(_1) }
        end
        report[:exit_code]
      end

      private

      # A whole number of 1 or more, as the command line gave it, or nil.
      #: (String?) -> Integer?
      def whole(word)
        number = word && Integer(word, 10, exception: false)
        number if number && number >= 1
      end

      #: () -> Hash[Symbol, untyped]
      def call_of
        walk = whole(@walk)
        return { refused: "--walk needs the number of a walk, a whole number of 1 or more (got #{@walk})" } if @walk && walk.nil?
        return walk ? { kind: "wait", walk: walk } : { kind: "wait" } if @action == "wait"

        pause = whole(@pause)
        unless pause
          return { refused: "nuka step #{@action} needs the number of the pause it answers, a whole number of 1 or more#{@pause.nil? ? "" : " (got #{@pause})"}" }
        end
        # An answer without its walk could reach a walk that replaced the
        # one the person was shown.
        return { refused: "nuka step #{@action} needs --walk, the number of the walk whose pause it answers" } unless walk

        { kind: "answer", walk: walk, pause: pause, answer: @action }
      end

      #: (String, String) -> String
      def joined(run_dir, relative) = "#{run_dir}/#{relative.tr("\\", "/")}"

      # What a person reads at a pause: where the step is, what it
      # recorded, the views of the page it left open, and the two answers.
      #: (Hash[Symbol, untyped], Hash[Symbol, untyped]) -> String
      def text(seen, fields)
        case seen[:state]
        when "gone" then "walk #{seen[:last][:number]} #{Engine::Walk.standing(seen)}\n"
        when "paused"
          pause = seen[:pause]
          run_dir = seen[:run_dir]
          scenario = seen[:scenario]
          views = pause[:views].map do |view|
            files = [view[:screenshot], view[:aria]].compact.map { joined(run_dir, _1) }
            name = view[:as].nil? ? "page #{view[:page]}" : "page #{view[:page]} of #{view[:as]}"
            title = view[:title].nil? ? "(no title)" : JSON.generate(view[:title])
            "  view: #{name} #{view[:url]} #{title}#{files.empty? ? " (no capture)" : ": #{files.join(" ")}"}"
          end
          stop = pause[:remaining].positive? ? "   (or: #{Engine::Walk.answer_command(seen[:number], pause[:pause], "stop")})" : ""
          lines = [
            "walk #{seen[:number]} paused after step #{pause[:pause]}/#{pause[:of]} (#{pause[:status]}): #{pause[:text]}",
            "  scenario: #{scenario[:feature]}:#{scenario[:line]} #{scenario[:name]} (#{scenario[:environment]})",
            *(pause[:failure] ? ["  failure: #{Engine::Walk.failure_text(pause)}"] : []),
            "  record: #{joined(run_dir, pause[:record])}/record.json",
            *views,
            *(seen[:world] ? ["  world: #{seen[:world][:url]}"] : []),
            "  do: #{Engine::Walk.answer_command(seen[:number], pause[:pause], "next")}#{stop}"
          ]
          "#{lines.join("\n")}\n"
        when "ended"
          run = seen[:end][:how] == "finished" && seen[:run_dir] ? ["  run: #{seen[:run_dir]}/run.json"] : []
          "#{["walk #{seen[:number]} #{Engine::Walk.standing(seen)}", *run].join("\n")}\n"
        else
          where = seen[:state] == "starting" ? "is starting: its run has not begun the scenario yet" : Engine::Walk.standing(seen)
          "walk #{seen[:number]} #{where}\n  do: #{fields[:do]}\n"
        end
      end

      #: (String, Integer, Array[Hash[Symbol, untyped]], Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def envelope(command, exit_code, findings, fields)
        verdict = { 0 => "passed", 1 => "failed" }.fetch(exit_code, "refused")
        { schema_version: Engine::RunRecord::SCHEMA_VERSION, nukadoko: VERSION, command: command, **fields, verdict: verdict, findings: findings }
      end

      #: (String, String, String, ?run: String?, ?fields: Hash[Symbol, untyped]) -> Integer
      def refuse(command, code, message, run: nil, fields: {})
        finding = Engine::Refusal.new(code, message, run: run).to_h(command)
        if @json then @out.puts JSON.pretty_generate(envelope(command, 2, [finding], fields))
        else print_finding(finding)
        end
        2
      end

      #: (Hash[Symbol, untyped]) -> void
      def print_finding(finding)
        @err.puts [finding[:severity], finding[:code], Engine::Summary.where_of(finding), finding[:message]].join("\t")
        @err.puts "  fix: #{finding[:fix]}" if finding[:fix]
        @err.puts "  do: #{finding[:do]}" if finding[:do]
      end
    end
  end
end
