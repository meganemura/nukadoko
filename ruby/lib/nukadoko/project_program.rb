# frozen_string_literal: true
# rbs_inline: enabled

require "json"
require "open3"
require "prism"
require "rbconfig"

# A tree's program under test: the `program` lambda of its
# nukadoko.config.rb, called once. A config with no program has none, and a
# run starts no world for it.
#
# The program goes with the code and the criteria with the config, so a
# `nuka run --base` tree can hold one side's config and the other side's
# program. The run writes that program beside the tree's config: the other
# side's config as nukadoko.tree-program.rb, or a ref's program file from
# before the program moved into the config as
# nukadoko.tree-legacy-program.rb. A project's own program file is refused,
# with the move to make. Boundary: reading the program; starting it is
# Program's.
module Nukadoko
  module Engine
    module ProjectProgram
      LIB = File.expand_path("..", __dir__.to_s)
      UPGRADING = 'CHANGELOG.md, under "The program moves into the config"'

      # The program of the tree at `root`, whose config is already loaded.
      # Its shape is checked whichever file holds it (ProgramShape).
      #: (String) -> Hash[Symbol, untyped]
      def self.read(root)
        raise called_in_config unless Nukadoko.legacy_program.nil?

        legacy_copy = File.join(root, TREE_LEGACY_PROGRAM)
        return ProgramShape.read(elsewhere(legacy_copy, legacy: true) || {}, LEGACY_PROGRAM) if File.exist?(legacy_copy)

        tree_copy = File.join(root, TREE_PROGRAM)
        return ProgramShape.read(elsewhere(tree_copy, legacy: false) || {}, CONFIG) if File.exist?(tree_copy)

        legacy = File.join(root, LEGACY_PROGRAM)
        raise moved if File.exist?(legacy)

        ProgramShape.read(called(Nukadoko.config_options[:program], CONFIG) || {}, CONFIG)
      end

      # Nukadoko.program called from the config would describe a program
      # nothing reads, so it is refused rather than left unstarted.
      #: () -> Refusal
      def self.called_in_config
        Refusal.new("config-invalid",
                    "Invalid config at #{CONFIG}: Nukadoko.program is no longer read: the program under test is the program: lambda of Nukadoko.config now",
                    fix: "Move the options Nukadoko.program took into #{CONFIG} as program: -> { { ... } }; #{UPGRADING}, shows the move.")
      end

      #: () -> Refusal
      def self.moved
        Refusal.new("program-file-moved",
                    "#{LEGACY_PROGRAM} is no longer read: the program under test is part of #{CONFIG} now, " \
                    "so nukadoko does not start what #{LEGACY_PROGRAM} describes.",
                    fix: "Move what #{LEGACY_PROGRAM} describes into #{CONFIG} as its program, and delete #{LEGACY_PROGRAM}; #{UPGRADING}, shows the move.")
      end

      # What a config's `program` returns, or nil when it has none.
      #: (untyped, String) -> Hash[Symbol, untyped]?
      def self.called(program, name)
        return nil if program.nil?
        unless program.respond_to?(:call)
          raise Refusal.new("config-invalid", "Invalid config at #{name}: program: must be a lambda that returns the program",
                            fix: "Write program in #{name} as program: -> { { serve: { command: ..., ready: ... } } }.")
        end

        value = program.call
        return value if value.is_a?(Hash)

        raise Refusal.new("config-invalid", "Invalid program at #{name}: the program lambda returned #{value.class}, not a Hash of the program's options",
                          fix: "Return the program's options as a Hash from program in #{name}.")
      end

      # The program `file` gives, read in a process of its own, since
      # loading it here would replace this tree's config and fixtures: a
      # config's program, or the options a legacy file passes to
      # Nukadoko.program. Raises a Refusal naming the file when it does not
      # load.
      #: (String, legacy: bool) -> Hash[Symbol, untyped]?
      def self.elsewhere(file, legacy:)
        read = legacy ? "Nukadoko.legacy_program" : "Nukadoko::Engine::ProjectProgram.called(Nukadoko.config_options[:program], ARGV[1])"
        script = "require \"nukadoko\"; load ARGV[0]; puts JSON.generate(#{read})"
        out, err, status = Open3.capture3(RbConfig.ruby, "-I", LIB, "-rjson", "-e", script, file, File.basename(file), chdir: File.dirname(file))
        unless status.success?
          raise Refusal.new("config-invalid", "Could not load #{File.basename(file)}: #{err.lines.first.to_s.strip}",
                            fix: "Correct #{File.basename(file)} as the message says.")
        end

        JSON.parse(out, symbolize_names: true)
      end

      # The text of a config with its program lambda cut out, so a change to
      # the program alone leaves the config's mapping as it was: the
      # program goes with the code, and a `--base` run compares only what
      # decides how the criteria are read. A config with no program, or
      # with more than one `program:` key, is read whole.
      #: (String) -> String
      def self.mapping_text(text)
        found = [] #: Array[Prism::Node]
        walk = lambda do |node|
          key = node.key if node.is_a?(Prism::AssocNode)
          if key.is_a?(Prism::SymbolNode) && key.unescaped == "program"
            found << node.value
          end
          node.compact_child_nodes.each { walk.(_1) }
        end
        walk.(Prism.parse(text).value)
        return text unless found.size == 1

        location = found.first.location
        bytes = text.b
        "#{bytes.byteslice(0, location.start_offset)}#{bytes.byteslice(location.end_offset..)}".force_encoding(text.encoding)
      end
    end
  end
end
