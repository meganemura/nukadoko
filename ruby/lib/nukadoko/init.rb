# frozen_string_literal: true
# rbs_inline: enabled

require "fileutils"

# `nuka init`: the config file, the steps directory, and the .gitignore
# entries, in the TypeScript engine's order and words. A config file
# already there refuses the whole command before anything is written, so a
# half-done init never looks like a finished one. It ends with a
# self-check that loads the config and the steps as `nuka steps` does; a
# failure there is reported and the files stay, so what init wrote can be
# looked at and fixed.
#
# The TypeScript engine also adds a package.json script and tsconfig
# entries. A Ruby project's one command for people and CI is a rake task,
# so a Rakefile with no `scenarios` task gets one that runs `nuka run`; a
# project with no Rakefile gets none, since a Rakefile written only for
# this would be a second place to look. The Gemfile is read too: one that
# does not name nukadoko gets a line on stderr.
module Nukadoko
  module Engine
    class Init
      STEPS = File.join("features", "steps")
      # `.env` files are ignored since a committed one is configuration, not
      # a secret source; `!.env.example` must follow `.env.*` to re-include it.
      IGNORED = [".nukadoko/", ".env", ".env.*", "!.env.example"].freeze
      # The gem's copy is staged at release; a checkout has only the root's.
      STAGED_LLMS = File.expand_path("../../llms.txt", __dir__.to_s)
      LLMS = File.file?(STAGED_LLMS) ? STAGED_LLMS : File.expand_path("../../../llms.txt", __dir__.to_s)
      # The gem ships no docs/, so the config file points at the spec online.
      SPEC = "https://github.com/meganemura/nukadoko/blob/main/docs/spec.md"
      TASK = <<~RUBY
        desc "Run the acceptance scenarios: nuka check, then every scenario under features/"
        task :scenarios do
          sh "bundle exec nuka run"
        end
      RUBY

      #: (String, out: IO, err: IO) -> void
      def initialize(project, out:, err:)
        @project = project
        @out = out
        @err = err
      end

      # The exit code, or a Refusal when a config file exists.
      #: () -> (Integer | Refusal)
      def call
        config = File.join(@project, CONFIG)
        if File.exist?(config)
          return Refusal.new("config-exists", "Refusing to init: #{config} already exists; nothing was written", run: "nuka check")
        end

        File.write(config, <<~RUBY)
          # Every config key nukadoko reads, one line each: #{SPEC}, "Environments and secrets"
          Nukadoko.config
        RUBY
        @out.puts CONFIG
        FileUtils.mkdir_p(File.join(@project, STEPS))
        @out.puts STEPS
        @out.puts ".gitignore" if ignore_entries
        @out.puts "Rakefile" if scenarios_task
        gemfile_note
        self_check
      end

      private

      # Appends each entry no line already ignores; true when it wrote.
      #: () -> bool
      def ignore_entries
        path = File.join(@project, ".gitignore")
        existing = File.exist?(path) ? File.read(path) : ""
        lines = existing.split(/\r?\n/)
        missing = IGNORED.reject { |entry| lines.any? { covers?(_1, entry) } }
        return false if missing.empty?

        prefix = existing.empty? || existing.end_with?("\n") ? existing : "#{existing}\n"
        File.write(path, "#{prefix}#{missing.join("\n")}\n")
        true
      end

      # Appends the `scenarios` task to a Rakefile that has none; true when it wrote.
      #: () -> bool
      def scenarios_task
        path = File.join(@project, "Rakefile")
        return false unless File.exist?(path)

        existing = File.read(path)
        return false if existing.match?(/^\s*task\s*\(?\s*(:scenarios|["']scenarios["'])/)

        prefix = existing.empty? || existing.end_with?("\n") ? existing : "#{existing}\n"
        File.write(path, "#{prefix}#{"\n" unless prefix.empty?}#{TASK}")
        true
      end

      # A root directory entry is also ignored by `/name`, `name`, or `name/**`.
      #: (String, String) -> bool
      def covers?(line, entry)
        trimmed = line.strip
        return true if trimmed == entry
        return false unless entry.end_with?("/")

        trimmed.delete_prefix("/").sub(%r{/(\*\*)?\z}, "") == entry.delete_suffix("/")
      end

      #: () -> void
      def gemfile_note
        gemfile = File.join(@project, "Gemfile")
        return unless File.exist?(gemfile)
        return if File.read(gemfile).match?(/^\s*gem\s+["']nukadoko["']/)

        @err.puts %(note: the Gemfile names no nukadoko gem; add gem "nukadoko", group: :test so bundle exec nuka runs this version)
      end

      #: () -> Integer
      def self_check
        load File.join(@project, CONFIG)
        Nukadoko.load_steps(File.join(@project, STEPS))
        @err.puts "next: read #{LLMS}, written for an agent: the loop, every command, and every finding code; its Ruby section is how a Ruby step is written"
        0
      rescue StandardError, ScriptError => e
        @err.puts ["error", "unexpected-error", "-", "Self-check failed: #{e.message}"].join("\t")
        @err.puts "  do: nuka check"
        1
      end
    end
  end
end
