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

      # `fix` and `run` are this refusal's own way past it; without either,
      # the code's registry fix and the command's --help stand in.
      def initialize(code, message, severity: "refused", fix: nil, run: nil)
        super(message)
        @code = code
        @severity = severity
        @fix = fix
        @run = run
      end

      # A refusal stops before anything runs (exit 2); a selection that kept
      # no scenario ran and found nothing to do (exit 1).
      def exit_code = severity == "refused" ? 2 : 1

      def to_h(command = "run")
        own = @fix || @run ? { fix: @fix || Codes.fix(code), do: @run }.compact : { fix: Codes.fix(code), do: "nuka #{command} --help" }
        { severity: severity, code: code, message: message, **own }
      end
    end

    class Selection
      TAG = /\A(not )?(@\S+)\z/

      # `whole_files` are the files a target named whole and --tag left
      # whole, which a rerun line may name as a file.
      attr_reader :scenarios, :selection, :tag_selection, :whole_files, :problems

      def initialize(project, targets, tags, features_dir: "features")
        @project = project
        @tags = tags.map { parse_tag(_1) }
        lines = Hash.new { |h, k| h[k] = [] }
        whole = []
        named = targets.empty? ? [features_dir] : targets
        named.each { add(_1, whole, lines) }
        line_target = named.find { _1.match?(/:\d+\z/) }
        if @tags.any? && line_target
          raise Refusal.new("invalid-value", "--tag selects among whole files, and #{JSON.generate(line_target)} already names one scenario",
                            fix: "Drop --tag to run that scenario, or drop the :line to select by tag in its file.")
        end

        files = (whole + lines.keys).uniq.sort
        @problems = []
        all = Dir.chdir(@project) { Engine.load_features(files, problems: @problems) }
        by_line = all.select { whole.include?(_1.uri) || lines[_1.uri].include?(_1.line) }
        lines.each do |file, wanted|
          wanted.each do |line|
            next if by_line.any? { _1.uri == file && _1.line == line }

            starts = all.select { _1.uri == file }.map(&:line).uniq.sort
            fix = starts.empty? ? "Add a scenario to #{file}; nothing in it can run yet." : "Name a line a scenario or an Examples row starts on: #{starts.join(", ")}."
            raise Refusal.new("no-scenario-at-line", "No scenario found at #{file}:#{line}", fix: fix)
          end
        end
        @scenarios = by_line.select { |s| @tags.all? { |negated, tag| s.tags.include?(tag) != negated } }
        left_out = by_line.size - @scenarios.size
        @whole_files = whole.select { |file| by_line.select { _1.uri == file }.all? { @scenarios.include?(_1) } }
        @tag_selection = { expressions: tags, left_out: left_out } if tags.any?
        @selection = all.size == @scenarios.size ? "full" : "partial"
        return unless @scenarios.empty? && @tags.any?

        flags = tags.flat_map { ["--tag", Selection.shell_word(_1)] }.join(" ")
        which = by_line.size == 1 ? "the 1 scenario" : "all #{by_line.size} scenarios"
        raise Refusal.new("nothing-selected", "no scenario to run: #{flags} left out #{which} of #{named.join(", ")}, so nothing was checked",
                          severity: "failed", fix: "Name a tag a scenario of the targets carries, or run without --tag.")
      end

      SHELL_SAFE = %r{\A[A-Za-z0-9_./:@%+,-][A-Za-z0-9_./:=@%+,-]*\z}

      # A word as a POSIX shell reads it back: as it is when it holds no
      # character the shell treats apart, otherwise in single quotes.
      def self.shell_word(word) = SHELL_SAFE.match?(word) ? word : "'#{word.gsub("'") { %q('\'') }}'"

      private

      def parse_tag(expression)
        match = TAG.match(expression)
        unless match
          raise Refusal.new("invalid-value", "--tag #{JSON.generate(expression)} is not an expression nuka run reads: " \
                                             "give \"@name\" or \"not @name\", and repeat --tag for a scenario that has to meet more than one")
        end

        [!match[1].nil?, match[2]]
      end

      def add(target, whole, lines)
        path, line = target.match(/\A(.*?)(?::(\d+))?\z/).captures
        absolute = File.expand_path(path, @project)
        if File.directory?(absolute)
          if line
            raise Refusal.new("line-on-directory", %(":line" has no meaning for a directory: #{target} names a directory, not a feature file),
                              fix: "Remove the :line suffix from the directory, or name a feature file.", run: "nuka run #{Selection.shell_word(path)}")
          end

          found = walk(absolute)
          if found.empty?
            raise Refusal.new("no-feature-files", %(no .feature file was found while scanning "#{path}"; nothing can run), fix: "Add a .feature file under #{path}.")
          end

          found.each { whole << relative(_1) unless whole.include?(relative(_1)) }
        elsif path.end_with?(".md")
          raise Refusal.new("markdown-target", "#{path} is a Markdown file: Markdown oaths were removed, and nukadoko reads scenarios from .feature files only",
                            fix: "Write the scenarios of #{path} as Gherkin in a .feature file, and name that file.")
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
