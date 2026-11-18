# frozen_string_literal: true
# rbs_inline: enabled

# The list of paths a claim step's `files` key reads: made from an earlier
# step's record, never from what its code returned. Each of that step's
# run_command processes lists the paths it added, changed, or removed
# under its working directory (`observed.processes[].files`); the key
# selects some changes and a directory. It does not choose the earlier
# step (the run and `nuka do --use` do) and does not judge a claim.
#
# A list is made only where every process of the step was walked whole,
# so an absence a claim reads is one nukadoko saw. A step that ran no
# process measured nothing, which is not an empty list.
module Nukadoko
  module Engine
    module ChangedFiles
      CHANGES = %w[added changed removed].freeze

      module_function

      # The step classes a files entry's `of` names.
      #: (Hash[untyped, untyped]) -> Array[singleton(Step)]
      def producers(entry)
        of = entry[:of] || entry["of"]
        of.is_a?(Array) ? of : [of]
      end

      #: (Hash[untyped, untyped]) -> Array[String]
      def changes(entry)
        change = entry[:change] || entry["change"]
        return CHANGES if change.nil?

        named = change.is_a?(Array) ? change : [change]
        CHANGES.select { named.include?(_1) }
      end

      #: (Hash[untyped, untyped]) -> String?
      def under(entry) = entry[:under] || entry["under"]

      #: (String) -> String
      def directory(under) = under.end_with?("/") ? under : "#{under}/"

      # `added or changed under src/`: how a record names what a key selects.
      #: (Hash[untyped, untyped]) -> String
      def describe(entry)
        words = changes(entry)
        text = words.size <= 2 ? words.join(" or ") : "#{words[0...-1].to_a.join(", ")}, or #{words.last}"
        (dir = under(entry)) ? "#{text} under #{directory(dir)}" : text
      end

      # The list `entry` reads from `source`, or why there is none. A source
      # is `{ of:, record: { step_record_id:, processes: } }` for a chosen
      # step, or `{ of:, unchosen: }`.
      #: (Hash[untyped, untyped], Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def side(entry, source)
        label = "files:#{source[:of]} #{describe(entry)}"
        return { label: label, unjudged: source[:unchosen] } if source[:unchosen]

        of = source[:of]
        processes = source.dig(:record, :processes) || []
        if processes.empty?
          return { label: label, unjudged: "#{of} ran no run_command process, so nukadoko measured no file for it, and a list it never measured is not an empty list" }
        end

        processes.each_with_index do |process, index|
          which = "process #{index + 1} of #{of}"
          files = process[:files]
          return { label: label, unjudged: "the record of #{which} lists no files, so what it changed was not measured" } if files.nil?
          return { label: label, unjudged: "nukadoko did not measure the files #{which} changed: #{files[:unmeasured]}" } if files[:unmeasured]
          if process[:group] == "running"
            return { label: label, unjudged: "#{which} left a process of its group running when it closed, so a file that process wrote after the walk is not in the list" }
          end
        end
        cwds = processes.map { _1[:cwd] }.uniq
        if cwds.size > 1
          return { label: label, unjudged: "the commands of #{of} ran in #{cwds.size} working directories, #{cwds.join(" and ")}, and each lists its paths relative to its own, so they make no one list" }
        end

        dir = (named = under(entry)) ? directory(named) : nil
        paths = [] #: Array[String]
        processes.each_with_index do |process, index|
          files = process[:files]
          unwalked = dir && (files[:skipped] || []).find { dir.start_with?(_1) }
          return { label: label, unjudged: "#{dir} is inside #{unwalked}, which process #{index + 1} of #{of} did not walk, so the list is empty whatever it did" } if unwalked

          changes(entry).each do |change|
            (files[change.to_sym] || []).each { |path| paths << path if dir.nil? || (path.start_with?(dir) && path != dir) }
          end
        end
        channel = processes.size == 1 ? "observed.processes[0].files" : "observed.processes"
        { label: label, paths: paths.uniq.sort, measured: { step_record_id: source.dig(:record, :step_record_id), channel: channel } }
      end
    end
  end
end
