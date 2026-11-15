# frozen_string_literal: true
# rbs_inline: enabled

require "digest"
require "fileutils"
require "json"
require "open3"
require "rbconfig"

# `nuka run --base <ref>`: what changed since the ref, and the trees the
# rows need to be judged against it. Two trees go in the run's own
# directory, under trees/:
#
# - base: the ref's code with head's features/ and config, so a new or
#   changed criterion runs where its behaviour should be absent. The ref's
#   program starts it, or head's when the ref has none: the program goes
#   with the code, so the run writes the ref's config beside head's as
#   nukadoko.tree-program.rb (or the ref's program file from before the
#   program moved into the config as nukadoko.tree-legacy-program.rb).
# - old: head's working tree with the ref's features/ and config, so an
#   unchanged criterion over a changed mapping runs under the steps it was
#   approved with. Head's config goes beside it as nukadoko.tree-program.rb,
#   so head's program starts it.
#
# The mapping is every file under features/ but a .feature file, the config
# file's bytes with its program lambda cut out, and the program's
# conditions and defaultEnvironments, which decide where a criterion is
# required. Every git command runs with
# hooks off, since a checkout's hook is the project's code and not the
# run's. Both trees are removed when the run ends.
module Nukadoko
  module Engine
    class Base
      NO_HOOKS = ["-c", "core.hooksPath=/dev/null"].freeze
      FEATURES = "features"
      STATE = ".nukadoko"

      attr_reader :ref #: String
      attr_reader :commit #: String
      attr_reader :changes #: Hash[untyped, Hash[Symbol, untyped]]
      attr_reader :removed #: Array[Criteria::Criterion]
      attr_reader :mapping #: Hash[Symbol, untyped]
      attr_reader :base_root #: String?
      attr_reader :old_root #: String?
      attr_reader :old_environments #: Array[Environment]?
      attr_reader :program_from_head #: bool?

      # The commit `ref` names, or a Refusal with the TypeScript engine's
      # code: outside git, a shallow clone that lacks it, or no such commit.
      #: (String, String) -> String
      def self.resolve(project, ref)
        shallow, ok = git(project, "rev-parse", "--is-shallow-repository")
        raise Refusal.new("base-outside-git", "nuka run --base #{ref} needs a git repository, and the project directory is not inside one") unless ok
        raise Refusal.new("base-ref-unknown", "--base #{JSON.generate(ref)} names no commit", run: "git log --oneline") if ref.empty? || ref.start_with?("-")

        commit, found = git(project, "rev-parse", "--verify", "--quiet", "#{ref}^{commit}")
        return commit if found && !commit.empty?
        if shallow == "true"
          raise Refusal.new("base-shallow", "--base #{ref} names no commit in this shallow clone, which holds only part of the history; fetch the base first",
                            run: "git fetch --unshallow origin")
        end

        raise Refusal.new("base-ref-unknown", "--base #{ref} names no commit in the project's repository", run: "git log --oneline")
      end

      #: (String, *String, ?strip: bool) -> [String, bool]
      def self.git(dir, *argv, strip: true)
        out, status = Open3.capture2({ "LC_ALL" => "C" }, "git", *NO_HOOKS, "-C", dir, *argv, err: File::NULL)
        [strip ? out.strip : out, status.success?]
      rescue SystemCallError
        ["", false]
      end

      # `selected` is each selected scenario's [feature, line]; `targets` the
      # run's targets without a line, or nil for the features directory.
      #: (project: String, ref: String, commit: String, run_dir: String, selected: Array[[String, Integer]], targets: Array[String]?, envs: Array[String], head_program: Hash[Symbol, untyped]?) -> void
      def initialize(project:, ref:, commit:, run_dir:, selected:, targets:, envs:, head_program:)
        @project = project
        @ref = ref
        @commit = commit
        @trees = File.join(run_dir, "trees")
        @top, = Base.git(project, "rev-parse", "--show-toplevel")
        @prefix = Base.git(project, "rev-parse", "--show-prefix").first.delete_suffix("/")
        @base_top = File.join(@trees, "base")
        @old_top = File.join(@trees, "old")
        prepare(selected, targets, envs, head_program)
      rescue StandardError
        cleanup
        raise
      end

      #: () -> void
      def cleanup
        if @worktree
          @worktree = false
          Base.git(@top, "worktree", "remove", "--force", "--force", @base_top)
        end
        FileUtils.rm_rf([@base_top, @old_top])
        Dir.rmdir(@trees) if Dir.exist?(@trees) && Dir.empty?(@trees)
      end

      # The ref's place of an unchanged head row, and the head row a place
      # at the ref is.
      #: ([String, Integer]) -> Hash[Symbol, untyped]?
      def at(key) = @changes[key]&.then { _1[:change] == "unchanged" ? _1[:at] : nil }

      #: (String, Integer) -> [String, Integer]?
      def row_of(feature, line) = @changes.find { |_, change| change[:at] == { feature: feature, line: line } }&.first

      #: () -> Hash[Symbol, untyped]
      def mapping_changes
        { files: @mapping[:files].map { File.join(FEATURES, _1) }, config: @mapping[:config], conditions: @mapping[:conditions],
          default_environments: @mapping[:default_environments], unseen: [] }
      end

      private

      #: (String) -> String
      def in_repo(path) = @prefix.empty? ? path : File.join(@prefix, path)

      #: (Array[[String, Integer]], Array[String]?, Array[String], Hash[Symbol, untyped]?) -> void
      def prepare(selected, targets, envs, head_program)
        FileUtils.mkdir_p(@trees)
        _, ok = Base.git(@top, "worktree", "add", "--detach", "--quiet", @base_top, @commit)
        raise Refusal.new("base-git-failed", "nuka run --base #{@ref} could not compare with the base: git worktree add failed") unless ok

        @worktree = true
        base_project = File.join(@base_top, @prefix)
        ref_paths = feature_files(base_project, [FEATURES, *targets.to_a])
        ref_criteria, @unparsed = Criteria.of_files(base_project, ref_paths)
        head_criteria, = Criteria.of_files(@project, feature_files(@project, [FEATURES, *targets.to_a]))
        compared = Criteria.compare(ref_criteria, head_criteria)
        @changes = compared[:changes]
        targeted = targets && feature_files(base_project, targets)
        @removed = targeted ? compared[:removed].select { targeted.include?(_1.feature) } : compared[:removed]

        head_files = working_tree_files
        ref_files = Base.git(@base_top, "ls-files", "-z", strip: false).first.split("\0").reject(&:empty?)
        ref_program = read_program(base_project)
        ref_config = File.join(base_project, CONFIG)
        ref_config_text = File.exist?(ref_config) ? File.read(ref_config) : nil
        @mapping = compare_mapping(head_files, ref_files, base_project, head_program, ref_program)

        wanted = selected.map { @changes[_1] }
        base_needed = wanted.any? { %w[changed new].include?(_1&.dig(:change)) }
        old_needed = wanted.any? { _1&.dig(:change) == "unchanged" && (@mapping[:changed] || _1[:retagged] || _1[:renamed_from]) }
        write_old_tree(head_files, ref_files) if old_needed
        if base_needed
          overlay_base_tree(head_files, ref_files, ref_program && ref_config_text)
          @base_root = base_project
          @program_from_head = ref_program.nil? && !(head_program || {}).empty?
        else
          @worktree = false
          Base.git(@top, "worktree", "remove", "--force", "--force", @base_top)
        end
        @old_root = File.join(@old_top, @prefix) if old_needed
        @old_environments = old_environments_of(ref_program, envs)
      end

      # The environments the old world runs in, with the conditions the ref's
      # program gives each; nil when the ref has no program, so
      # head's environments are the old world's too.
      #: (Hash[Symbol, untyped]?, Array[String]) -> Array[Environment]?
      def old_environments_of(program, envs)
        return nil if program.nil? || program[:problem]

        declared = program[:environments]
        names = if envs.any? then envs
                elsif program[:defaultEnvironments] then program[:defaultEnvironments]
                else
                  conditioned = declared.select { |_, e| e[:conditions] }.keys
                  conditioned.any? ? conditioned : ["default"]
                end
        names.map { |name| Environment.new(name, (declared.dig(name, :conditions) || {}).transform_keys(&:to_s), {}, Program.env_files(declared[name] || {})) }
      end

      #: (String, Array[String]) -> Array[String]
      def feature_files(root, targets)
        targets.flat_map do |target|
          absolute = File.join(root, target)
          if File.directory?(absolute) then Dir.glob("**/*.feature", base: absolute).sort.map { File.join(target, _1) }
          elsif target.end_with?(".feature") && File.file?(absolute) then [target]
          else []
          end
        end.uniq.sort
      end

      # Head's working tree as a copy holds it: tracked files and untracked
      # ones git does not ignore, on disk, outside the state directory.
      #: () -> Array[String]
      def working_tree_files
        listed = Base.git(@top, "ls-files", "-z", "--cached", "--others", "--exclude-standard", strip: false).first.split("\0").reject(&:empty?)
        listed.uniq.reject { within?(_1, in_repo(STATE)) }.select { File.exist?(File.join(@top, _1)) || File.symlink?(File.join(@top, _1)) }
      end

      #: (String, String) -> bool
      def within?(file, dir) = dir.empty? || file == dir || file.start_with?("#{dir}/")

      #: (String) -> bool
      def mapping?(file) = within?(file, in_repo(FEATURES)) || file == in_repo(CONFIG)

      #: (String) -> String
      def hash_of(file) = File.symlink?(file) ? "link:#{File.readlink(file)}" : Digest::SHA256.file(file).hexdigest

      #: (Array[String], String) -> Hash[String, String]
      def mapping_files(files, top)
        dir = in_repo(FEATURES)
        files.select { within?(_1, dir) && !_1.end_with?(".feature") && File.file?(File.join(top, _1)) }
             .to_h { [_1.delete_prefix("#{dir}/"), hash_of(File.join(top, _1))] }
      end

      # The ref's program: its program file from before the program moved
      # into the config, or its config's program, read in a process of its
      # own (ProjectProgram.elsewhere). nil when the ref has neither.
      #: (String) -> Hash[Symbol, untyped]?
      def read_program(root)
        legacy = File.join(root, LEGACY_PROGRAM)
        config = File.join(root, CONFIG)
        program = if File.exist?(legacy) then ProjectProgram.elsewhere(legacy, legacy: true) || {}
                  elsif File.exist?(config) then ProjectProgram.elsewhere(config, legacy: false)
                  end
        return nil if program.nil?

        { environments: (program[:environments] || {}).transform_keys(&:to_s), defaultEnvironments: program[:defaultEnvironments] }
      rescue Refusal => e
        { problem: e.message }
      end

      #: (Hash[Symbol, untyped]?) -> Hash[Symbol, untyped]
      def program_mapping(program)
        environments = (program && program[:environments]) || {}
        { conditions: environments.to_h { |name, e| [name.to_s, JSON.generate(e[:conditions])] }, defaults: JSON.generate(program && program[:defaultEnvironments]) }
      end

      #: (Array[String], Array[String], String, Hash[Symbol, untyped]?, Hash[Symbol, untyped]?) -> Hash[Symbol, untyped]
      def compare_mapping(head_files, ref_files, base_project, head_program, ref_program)
        head = mapping_files(head_files, @top)
        ref = mapping_files(ref_files, @base_top)
        files = (head.keys | ref.keys).select { head[_1] != ref[_1] }.sort
        config_hash = ->(root) { File.exist?(File.join(root, CONFIG)) ? Digest::SHA256.hexdigest(ProjectProgram.mapping_text(File.read(File.join(root, CONFIG)))) : nil }
        config = config_hash.(@project) != config_hash.(base_project)
        after = program_mapping(head_program && { environments: (head_program[:environments] || {}).transform_keys(&:to_s), defaultEnvironments: head_program[:defaultEnvironments] })
        if ref_program&.dig(:problem)
          conditions = after[:conditions].keys.sort
          defaults = true
        else
          before = program_mapping(ref_program)
          none = JSON.generate(nil)
          conditions = (before[:conditions].keys | after[:conditions].keys).select { before[:conditions].fetch(_1, none) != after[:conditions].fetch(_1, none) }.sort
          defaults = before[:defaults] != after[:defaults]
        end
        changed = files.any? || config || conditions.any? || defaults || !ref_program&.dig(:problem).nil?
        { changed: changed, files: files, config: config, conditions: conditions, default_environments: defaults }
      end

      #: (String, String) -> void
      def copy(from, to)
        FileUtils.mkdir_p(File.dirname(to))
        FileUtils.rm_rf(to)
        File.symlink?(from) ? File.symlink(File.readlink(from), to) : FileUtils.cp(from, to)
      end

      # The ref's checkout loses the ref's mapping and gains head's. The
      # ref's program stays: its program file under the tree's own name, or
      # its config `ref_config` beside head's. When the ref has no program,
      # head's config brings head's.
      #: (Array[String], Array[String], String?) -> void
      def overlay_base_tree(head_files, ref_files, ref_config)
        ref_files.select { mapping?(_1) }.each { FileUtils.rm_f(File.join(@base_top, _1)) }
        head_files.select { mapping?(_1) }.each { copy(File.join(@top, _1), File.join(@base_top, _1)) }
        legacy = File.join(@base_top, in_repo(LEGACY_PROGRAM))
        if File.exist?(legacy)
          FileUtils.mv(legacy, File.join(@base_top, in_repo(TREE_LEGACY_PROGRAM)))
        elsif ref_config
          File.write(File.join(@base_top, in_repo(TREE_PROGRAM)), ref_config)
        end
      end

      # Head's working tree with the ref's mapping in place of its own,
      # written before the base checkout is overlaid. Head's program stays:
      # head's config goes beside the ref's, or a file that names no
      # program when head has no config.
      #: (Array[String], Array[String]) -> void
      def write_old_tree(head_files, ref_files)
        head_files.reject { mapping?(_1) }.each { copy(File.join(@top, _1), File.join(@old_top, _1)) }
        ref_files.select { mapping?(_1) }.each { copy(File.join(@base_top, _1), File.join(@old_top, _1)) }
        head_config = File.join(@project, CONFIG)
        tree_program = File.join(@old_top, in_repo(TREE_PROGRAM))
        FileUtils.mkdir_p(File.dirname(tree_program))
        File.write(tree_program, File.exist?(head_config) ? File.read(head_config) : "# Head has no config, so no program.\n")
      end
    end
  end
end
