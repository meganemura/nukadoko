# frozen_string_literal: true

require "pathname"

# Which scenarios a run executes: the targets on the command line (feature
# files, `file:line` selections, directories) narrowed by `--tag`. A target
# that names nothing runnable is refused before anything runs, with the
# TypeScript engine's code for the same mistake, so a run never quietly
# does less than its command line asked for.
module Nukadoko
  module Engine
    class Refusal < StandardError
      attr_reader :code, :severity

      def initialize(code, message, severity: "refused")
        super(message)
        @code = code
        @severity = severity
      end

      # A refusal stops before anything runs (exit 2); a selection that kept
      # no scenario ran and found nothing to do (exit 1).
      def exit_code = severity == "refused" ? 2 : 1
      def to_h = { severity: severity, code: code, message: message }
    end

    class Selection
      TAG = /\A(not )?(@\S+)\z/

      attr_reader :scenarios, :selection, :tag_selection

      def initialize(project, targets, tags, features_dir: "features")
        @project = project
        @tags = tags.map { parse_tag(_1) }
        lines = Hash.new { |h, k| h[k] = [] }
        whole = []
        (targets.empty? ? [features_dir] : targets).each { add(_1, whole, lines) }
        if @tags.any? && lines.any?
          raise Refusal.new("invalid-value", "--tag selects among whole files, and \"#{lines.keys.first}:#{lines.values.first.first}\" already names one scenario; drop the line or the tag")
        end

        files = (whole + lines.keys).uniq.sort
        all = Dir.chdir(@project) { Engine.load_features(files) }
        by_line = all.select { whole.include?(_1.uri) || lines[_1.uri].include?(_1.line) }
        lines.each do |file, wanted|
          wanted.each do |line|
            raise Refusal.new("no-scenario-at-line", "No scenario found at #{file}:#{line}") if by_line.none? { _1.uri == file && _1.line == line }
          end
        end
        @scenarios = by_line.select { |s| @tags.all? { |negated, tag| s.tags.include?(tag) != negated } }
        left_out = by_line.size - @scenarios.size
        @tag_selection = { expressions: tags, left_out: left_out } if tags.any?
        @selection = all.size == @scenarios.size ? "full" : "partial"
        return unless @scenarios.empty? && @tags.any?

        raise Refusal.new("nothing-selected", "no scenario to run: --tag #{tags.join(" --tag ")} left out all #{by_line.size} scenarios", severity: "failed")
      end

      private

      def parse_tag(expression)
        match = TAG.match(expression)
        raise Refusal.new("invalid-value", "--tag #{expression.inspect} is not an expression nuka run reads: write @name or not @name, and repeat --tag for more than one") unless match

        [!match[1].nil?, match[2]]
      end

      def add(target, whole, lines)
        path, line = target.match(/\A(.*?)(?::(\d+))?\z/).captures
        absolute = File.expand_path(path, @project)
        if File.directory?(absolute)
          raise Refusal.new("line-on-directory", %(":line" has no meaning for a directory: #{target} names a directory, not a feature file)) if line

          found = walk(absolute)
          raise Refusal.new("no-feature-files", %(no .feature file was found while scanning "#{path}"; nothing can run)) if found.empty?

          found.each { whole << relative(_1) unless whole.include?(relative(_1)) }
        elsif path.end_with?(".md")
          raise Refusal.new("markdown-target", "#{path} is a Markdown file: nukadoko reads scenarios from .feature files only")
        elsif !File.file?(absolute)
          raise Refusal.new("target-not-found", "Feature file not found: #{path}")
        elsif line
          lines[relative(absolute)] << Integer(line, 10)
        else
          whole << relative(absolute) unless whole.include?(relative(absolute))
        end
      end

      # Every .feature file below dir, skipping node_modules and any directory
      # whose name starts with a dot, as step discovery skips them.
      def walk(dir)
        Dir.children(dir).sort.flat_map do |name|
          full = File.join(dir, name)
          if File.directory?(full)
            name.start_with?(".") || name == "node_modules" ? [] : walk(full)
          else
            name.end_with?(".feature") ? [full] : []
          end
        end
      end

      # Two spellings of one file are one file: a target is named by its real
      # path relative to the project, so it is selected once.
      def relative(absolute)
        Pathname.new(File.realpath(absolute)).relative_path_from(Pathname.new(File.realpath(@project))).to_s
      end
    end
  end
end
