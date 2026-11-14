# frozen_string_literal: true
# rbs_inline: enabled

require "json"
require "time"

# `nuka verdict`: whether the newest run that ended judged the working tree
# as it is now and left nothing red. It reads run.json files and one git
# tree id, and never starts a run. A run's red findings are relayed only
# when it judged this tree: a red row of an earlier tree may be fixed
# already, and a green one may not hold now.
module Nukadoko
  module Engine
    class Verdict
      FIXES = {
        "run-without-base" => "No change is necessary. Run with --base and the commit the change started from to have new and changed criteria proven against it.",
        "working-tree-unknown" => "No change is necessary. In a git repository with a commit, nuka verdict compares the tree with the one the run judged."
      }.freeze

      attr_reader :judged, :findings, :newest, :working_tree

      def initialize(project)
        # The tree is read before the runs: a run that ends in between is
        # judged against the tree before it, which can only make the answer
        # stale, never wrongly fresh.
        @working_tree = RunRecord.commit(project)&.fetch(:working_tree)
        @newest = Verdict.newest_run(project)
        @judged, @findings = judge
      end

      # The run with the latest start; a run.json whose run_id is not its
      # directory's name, or that does not parse, is no run.
      def self.newest_run(project)
        Dir.glob(File.join(project, ".nukadoko", "runs", "*", "run.json")).filter_map do |file|
          run = JSON.parse(File.read(file), symbolize_names: true)
          started = Time.iso8601(run[:started_at]) rescue nil
          run if started && run[:run_id] == File.basename(File.dirname(file))
        rescue JSON::ParserError
          nil
        end.max_by { [Time.iso8601(_1[:started_at]), _1[:run_id]] }
      end

      def open? = findings.any? { %w[failed error].include?(_1[:severity]) }

      def envelope_fields
        { judged: judged, working_tree: working_tree, run_id: newest&.fetch(:run_id), run_dir: newest&.fetch(:run_dir, nil),
          run_working_tree: newest && recorded, base: newest&.dig(:table, :base) }
      end

      def headline
        id = newest && newest[:run_id]
        case judged
        when "missing" then "failed: no run has ended, so nothing judged this working tree"
        when "stale" then "failed: the newest run, #{id}, judged another working tree"
        when "unknown"
          "#{open? ? "failed" : "passed"}: the newest run, #{id}, #{open? ? "leaves open what is below" : "left nothing red"}; whether it judged this working tree is unknown"
        else
          open? ? "failed: the newest run, #{id}, judged this working tree, and it leaves open what is below" : "passed: the newest run, #{id}, judged this working tree and left nothing red"
        end
      end

      private

      def recorded
        tree = newest.dig(:commit, :working_tree) if newest[:commit].is_a?(Hash)
        tree.is_a?(String) && !tree.empty? ? tree : nil
      end

      def again = "nuka run"

      def judge
        unless newest
          return ["missing", [{ severity: "failed", code: "run-missing", message: "no nuka run has ended in this project, so nothing judged this working tree", do: again }]]
        end

        id = newest[:run_id]
        if working_tree && recorded != working_tree
          return ["stale", [{ severity: "failed", code: "run-stale", message: stale_message, do: again }]]
        end

        findings = []
        unless working_tree
          findings << note("working-tree-unknown", "git gave no id for the working tree (outside a repository, before its first commit, or a git call failed), so whether the newest run #{id} judged it is unknown; the verdict below is that run's own")
        end
        if newest[:selection] == "partial"
          findings << { severity: "failed", code: "run-partial", do: again,
                        message: "the newest run #{id} left out scenarios of the files it named (a :line target or --tag), so the criteria it left out were not judged" }
        end
        red = (newest[:findings] || []).select { %w[failed error].include?(_1[:severity]) }
        findings.concat(red)
        if newest[:verdict] == "failed" && red.empty?
          findings << { severity: "failed", code: "run-failed", message: "the newest run #{id} failed, and its run.json holds no failed finding that says why",
                        do: "nuka report #{newest[:run_dir] || id} --format markdown" }
        end
        if newest.dig(:table, :base).nil?
          findings << note("run-without-base", "the newest run #{id} had no --base, so no row says which criteria are new or changed, and a new one that passes without the change was not caught")
        end
        [working_tree ? "judged" : "unknown", findings]
      end

      def note(code, message) = { severity: "note", code: code, message: message, fix: FIXES.fetch(code) }

      def stale_message
        head = "the newest run #{newest[:run_id]} (started #{newest[:started_at]})"
        return "#{head} recorded no working tree id (outside git then, or written by an earlier nukadoko), so it cannot be matched to the working tree #{working_tree[0, 12]}" unless recorded

        "#{head} judged working tree #{recorded[0, 12]}, and the working tree is now #{working_tree[0, 12]}: its verdicts say nothing about what changed since"
      end
    end
  end
end
