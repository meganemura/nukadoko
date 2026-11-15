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
# entries; a Ruby project has neither, so the Gemfile is what init looks
# at: a Gemfile that does not name nukadoko gets a line on stderr.
module Nukadoko
  module Engine
    class Init
      CONFIG = "nukadoko.config.rb"
      STEPS = File.join("features", "steps")
      # `.env` files are ignored since a committed one is configuration, not
      # a secret source; `!.env.example` must follow `.env.*` to re-include it.
      IGNORED = [".nukadoko/", ".env", ".env.*", "!.env.example"].freeze
      README = File.expand_path("../../README.md", __dir__.to_s)

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
          # Every config key nukadoko reads, one line each: docs/spec.md, "Environments and secrets"
          Nukadoko.config
        RUBY
        @out.puts CONFIG
        FileUtils.mkdir_p(File.join(@project, STEPS))
        @out.puts STEPS
        @out.puts ".gitignore" if ignore_entries
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
        @err.puts "next: read #{README}: the steps, the commands, and the program file"
        0
      rescue StandardError, ScriptError => e
        @err.puts ["error", "unexpected-error", "-", "Self-check failed: #{e.message}"].join("\t")
        @err.puts "  do: nuka check"
        1
      end
    end
  end
end
