# frozen_string_literal: true
# rbs_inline: enabled

# Responsibility: the intent a change declares (docs/intent.md), read
# under `nuka run --base`: the file at the repository's top as head's
# working tree holds it, and what git says of it since the base. Boundary:
# git and the disk only; the format is Intent's, what each row came to
# IntentView's.
#
# The file is the change's when the change wrote it: a file the base
# already holds unchanged is an earlier change's intent, merged with it,
# and says nothing about this one. So a run reads it only when head's
# text differs from the base's, and a change that removes it declares
# nothing.
#
# The reviewer reads when it was declared: in the change's first commit,
# before anything it judges was written, or later, and each commit since
# that changed it again. A change of intent is itself a difference the
# reviewer approves, so it is named, never folded into the rows.
module Nukadoko
  module Engine
    module IntentFile
      # git did not answer.
      class GitFailed < StandardError; end

      module_function

      # The intent the change at `project` declares against `base_commit`:
      # `{ intent:, record: }`, the record run.json's `intent` before its
      # rows are judged, or nil when it declares none. Raises GitFailed
      # when git does not answer.
      #: (String, String) -> Hash[Symbol, untyped]?
      def read(project, base_commit)
        top = git(project, "rev-parse", "--show-toplevel").strip
        prefix = git(project, "rev-parse", "--show-prefix").strip.delete_suffix("/")
        file = File.join(top, Intent::FILE)
        return nil unless File.file?(file)

        text = File.read(file, encoding: "UTF-8")
        return nil if text == at_commit(top, base_commit)

        all = commits_since(top, base_commit)
        touched = commits_since(top, base_commit, Intent::FILE)
        first, *later = touched
        at_head = all.empty? ? at_commit(top, base_commit) : at_commit(top, all.fetch(-1)[:commit])
        { intent: Intent.parse(text),
          record: { file: "#{"../" * (prefix.empty? ? 0 : prefix.split("/").size)}#{Intent::FILE}",
                    declared_in: first && first.merge(first: first[:commit] == all.first&.dig(:commit)),
                    changed_after: later, uncommitted: text != at_head, problems: [] } }
      end

      #: (String, *String) -> String
      def git(dir, *argv)
        out, ok = Base.git(dir, *argv, strip: false)
        raise GitFailed, "git #{argv.first} failed in #{dir}" unless ok

        out
      end

      # The file at a commit, or nil when the commit holds none.
      #: (String, String) -> String?
      def at_commit(top, commit)
        listed = git(top, "ls-tree", "-z", "--name-only", commit, "--", Intent::FILE).split("\0")
        return nil unless listed.include?(Intent::FILE)

        git(top, "show", "#{commit}:#{Intent::FILE}").force_encoding("UTF-8")
      end

      # The commits after `base` up to HEAD, oldest first, each with its
      # subject: all of them, or with `file`, those that changed it.
      #: (String, String, ?String?) -> Array[Hash[Symbol, String]]
      def commits_since(top, base, file = nil)
        out = git(top, "log", "-z", "--reverse", "--format=%H%x09%s", "#{base}..HEAD", *(file ? ["--", file] : []))
        out.force_encoding("UTF-8").split("\0").reject(&:empty?).map do |line|
          commit, subject = line.split("\t", 2)
          { commit: commit.to_s, subject: subject.to_s }
        end
      end
    end
  end
end
