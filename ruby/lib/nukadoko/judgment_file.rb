# frozen_string_literal: true
# rbs_inline: enabled

require "fileutils"

# Where the judgments of a feature file live, reading and writing them,
# and, under `--base`, which of them changed since the ref (docs/spec.md
# "Judgments"). What an entry means is lib/nukadoko/judgments.rb's.
#
# The files sit in `judgments/` at the project root, one per feature file
# at the same relative path with `.json` added, outside the features
# directory on purpose: there every file is mapping, so a judgment added
# would make `--base` run each unchanged criterion again in the old world,
# when a judgment changes no step. Nor do they live in the run directory,
# which retention removes and nobody reviews: a judgment is committed, and
# the commit and its review are the record of who judged.
module Nukadoko
  module Engine
    module JudgmentFile
      DIR = "judgments"

      module_function

      #: (String) -> String
      def of(feature) = "#{DIR}/#{feature}.json"

      # What a feature's judgment file holds: its entries, none when there
      # is no file, or why it could not be read.
      #: (String, String) -> Hash[Symbol, untyped]
      def read(root, feature)
        text = begin
          File.read(File.join(root, of(feature)), encoding: "UTF-8")
        rescue Errno::ENOENT
          return { entries: [] }
        rescue SystemCallError, IOError => e
          return { problem: "it could not be read: #{e.message}" }
        end
        Judgments.parse_file(text)
      end

      # Writes a feature's judgment file whole, and returns its path
      # relative to the project root.
      #: (String, String, Array[Hash[Symbol, untyped]]) -> String
      def write(root, feature, entries)
        relative = of(feature)
        file = File.join(root, relative)
        FileUtils.mkdir_p(File.dirname(file))
        File.write(file, Judgments.file_text(entries))
        relative
      end

      # Each judgment file the working tree and `commit` hold with other
      # text, or one holds and the other does not, relative to the project
      # root and sorted. nil when git does not answer.
      #: (String, String) -> Array[String]?
      def changed(project, commit)
        top, ok = Base.git(project, "rev-parse", "--show-toplevel")
        return nil unless ok

        prefix = Base.git(project, "rev-parse", "--show-prefix").first.delete_suffix("/")
        dir = prefix.empty? ? "#{DIR}/" : "#{prefix}/#{DIR}/"
        listed, ok = Base.git(top, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", dir, strip: false)
        return nil unless ok

        at_base, ok = Base.git(top, "ls-tree", "-r", "-z", "--name-only", commit, "--", dir, strip: false)
        return nil unless ok

        names = (listed.split("\0") + at_base.split("\0")).reject(&:empty?).uniq
        names.filter_map do |name|
          now = File.file?(File.join(top, name)) ? File.binread(File.join(top, name)) : nil
          before, found = Base.git(top, "show", "#{commit}:#{name}", strip: false)
          before = nil unless found
          name.delete_prefix(prefix.empty? ? "" : "#{prefix}/") if now != before&.b
        end.sort
      end

      # What `commit` holds as the judgments of a feature file: its
      # entries, none when it holds no such file, or why the file did not
      # parse. nil when git does not answer.
      #: (String, String, String) -> Hash[Symbol, untyped]?
      def at_commit(project, commit, feature)
        prefix, ok = Base.git(project, "rev-parse", "--show-prefix")
        return nil unless ok

        prefix = prefix.delete_suffix("/")
        name = prefix.empty? ? of(feature) : "#{prefix}/#{of(feature)}"
        top, ok = Base.git(project, "rev-parse", "--show-toplevel")
        return nil unless ok

        listed, ok = Base.git(top, "ls-tree", "-z", "--name-only", commit, "--", name, strip: false)
        return nil unless ok
        return { entries: [] } unless listed.split("\0").include?(name)

        text, ok = Base.git(top, "show", "#{commit}:#{name}", strip: false)
        ok ? Judgments.parse_file(text.dup.force_encoding("UTF-8")) : nil
      end
    end
  end
end
