# frozen_string_literal: true
# rbs_inline: enabled

# What the TypeScript engine's defineStep refuses when a step file loads:
# a claim or a poll that could only be judged one way, or that would let a
# line fill the value a claim measures. The Ruby engine reads the same
# declarations after loading, and check reports the first as the
# TypeScript engine does, as step-file-import-failed, so the step leaves
# the vocabulary.
module Nukadoko
  module Engine
    class Definition
      # setTimeout's own limit, which a poll's timeout cannot pass.
      MAX_TIMEOUT_MS = 2_147_483_647

      #: (singleton(Step)) -> void
      def initialize(step)
        @step = step
        @observe = step.method_defined?(:observe) #: bool
      end

      #: () -> Array[String]
      def problems
        problem = timeout_problem
        return ["#{@step.name} #{problem}."] if problem

        # Named by the class, as the TypeScript engine names its defineStep
        # call, and in the order it meets each refusal: a claim step's
        # options and claims, then the states.
        problem = @step.claims ? claim_step_problem(@step.claims) : run_step_problem
        problem ||= (states = States.read(@step)).is_a?(String) ? states : nil
        problem ? ["#{@step.name} #{problem}."] : []
      end

      private

      #: (untyped) -> String?
      def claim_step_problem(claims)
        refused = %i[gives ends].find { @step.public_send(_1).any? }
        return "#{refused} is not an option of a claim step: a claim step has no action, so it leaves no state; it may require one" if refused

        events_problem || files_problem || ClaimRules.first_problem(claims, shape) || poll_problem
      end

      #: () -> String?
      def run_step_problem
        option = %i[events files].find { !@step.instance_variable_get(:"@#{_1}").nil? }
        return nil unless option

        "#{option} belongs to a claim step, and this definition has no claims. A step that acts uses run; a step that judges declares claims"
      end

      EVENTS_ENTRY_KEYS = %w[of count].freeze

      # Why `events` is not a hash of counts the run can read: each key one
      # word a claim's actual can name, each entry `{ of:, count: }` with
      # `of` a step or a list of distinct ones, and `count` a selection the
      # format can judge.
      #: () -> String?
      def events_problem
        events = @step.instance_variable_get(:@events)
        return nil if events.nil?
        return "events must be an object whose keys name counts, each { of, count }" unless events.is_a?(Hash)

        events.each do |key, entry|
          unless key.match?(/\A[^.]+\z/)
            return %(events key #{key.to_json} is not one key a claim's actual can name; name it with one word and no dot)
          end
          return "events.#{key} must be an object with of, the step whose events it counts, and count, the lines it counts" unless entry.is_a?(Hash)

          unknown = entry.keys.map(&:to_s).find { !EVENTS_ENTRY_KEYS.include?(_1) }
          return %(events.#{key} has the key "#{unknown}", which an events entry does not have. It has #{EVENTS_ENTRY_KEYS.join(", ")}) if unknown

          of = entry[:of] || entry["of"]
          candidates = of.is_a?(Array) ? of : [of]
          if candidates.empty? || !candidates.all? { _1.is_a?(Class) && _1 < Step }
            return "events.#{key}.of must be a step class, or a non-empty list of them; name the step whose events it counts"
          end
          return "events.#{key}.of names one step twice" if candidates.uniq.size != candidates.size

          problems = Events::Selection.problems(Events::Selection.normalize(entry[:count] || entry["count"]), "events.#{key}.count")
          return problems.join("; ") if problems.any?
        end
        nil
      end

      FILES_ENTRY_KEYS = %w[of change under].freeze
      FILE_CHANGES = %w[added changed removed].freeze
      UNWALKED = %w[node_modules .git].freeze

      # Why `files` is not a hash of lists the run can read: each key one
      # word a claim's actual can name, each entry `{ of:, change:, under: }`
      # with `of` a step or a list of distinct ones, `change` one of the
      # changes a record lists or a list of them, and `under` a directory
      # relative to the working directory that a walk enters.
      #: () -> String?
      def files_problem
        files = @step.instance_variable_get(:@files)
        return nil if files.nil?
        return "files must be an object whose keys name lists of paths, each { of, change?, under? }" unless files.is_a?(Hash)

        files.each do |key, entry|
          unless key.match?(/\A[^.]+\z/)
            return %(files key #{key.to_json} is not one key a claim's actual can name; name it with one word and no dot)
          end
          return "files.#{key} must be an object with of, the step whose commands changed the files" unless entry.is_a?(Hash)

          unknown = entry.keys.map(&:to_s).find { !FILES_ENTRY_KEYS.include?(_1) }
          return %(files.#{key} has the key "#{unknown}", which a files entry does not have. It has #{FILES_ENTRY_KEYS.join(", ")}) if unknown

          of = entry[:of] || entry["of"]
          candidates = of.is_a?(Array) ? of : [of]
          if candidates.empty? || !candidates.all? { _1.is_a?(Class) && _1 < Step }
            return "files.#{key}.of must be a step class, or a non-empty list of them; name the step whose commands changed the files"
          end
          return "files.#{key}.of names one step twice" if candidates.uniq.size != candidates.size

          change = entry[:change] || entry["change"]
          unless change.nil?
            changes = change.is_a?(Array) ? change : [change]
            if changes.empty? || !changes.all? { FILE_CHANGES.include?(_1) }
              return "files.#{key}.change must be one of #{FILE_CHANGES.join(", ")}, or a non-empty list of them; leave it out for every change"
            end
            return "files.#{key}.change names one change twice" if changes.uniq.size != changes.size
          end
          under = entry[:under] || entry["under"]
          next if under.nil?

          problem = under_problem(under)
          return "files.#{key}.under #{problem}" if problem
        end
        nil
      end

      # A record's paths are relative and `/`-separated, so an absolute
      # path, a backslash, or a `.` or `..` segment matches none of them,
      # and a list under node_modules or .git is empty whatever the command did.
      #: (untyped) -> String?
      def under_problem(under)
        return %(must be a directory relative to the command's working directory, such as "src/"; got #{ClaimRules.describe(under)}) unless under.is_a?(String)

        segments = under.delete_suffix("/").split("/", -1)
        if under.start_with?("/") || under.include?("\\") || segments.any? { _1.empty? || _1 == "." || _1 == ".." }
          return %(is #{under.to_json}, and a record lists each path relative to the command's working directory, with / between its parts, so no path is under it. Name the directory that way, such as "src/")
        end
        unwalked = segments.find { UNWALKED.include?(_1) }
        unwalked ? %(is #{under.to_json}, inside a #{unwalked} directory, which run_command does not walk, so the list is empty whatever the command did) : nil
      end

      #: () -> ClaimRules::Shape
      def shape
        fields = @step.args.fields
        ClaimRules::Shape.new(
          patterns: @step.patterns, args_keys: fields.map { _1.name.to_s },
          string_args: fields.select { _1.type == :string }.map { _1.name.to_s },
          from_keys: @step.from.keys.map(&:to_s), capture_keys: @step.patterns.flat_map { Pattern.new(_1).keys }.uniq,
          observe: @observe, files: @step.files.is_a?(Hash) ? @step.files.keys : [],
          events: @step.events.is_a?(Hash) ? @step.events.keys : [], events_sentence: events_sentence
        )
      end

      # Each value the step's selections take from the sentence.
      #: () -> Array[Hash[Symbol, String]]
      def events_sentence
        events = @step.events
        return [] unless events.is_a?(Hash)

        events.flat_map do |key, entry|
          count = entry.is_a?(Hash) ? Events::Selection.normalize(entry[:count] || entry["count"]) : nil
          Events::Selection.sentence_values(count).map { { key: key, field: _1[:field].to_s, name: _1[:name].to_s } }
        end
      end

      # A deadline the step could never keep is refused when it loads, as
      # the TypeScript engine refuses one Node's timer would clamp.
      #: () -> String?
      def timeout_problem
        timeout = @step.timeout
        return nil if timeout.nil? || (timeout.is_a?(Integer) && timeout.positive? && timeout <= MAX_TIMEOUT_MS)

        "timeout must be a whole number of milliseconds greater than 0 and at most #{MAX_TIMEOUT_MS}; got #{ClaimRules.describe(timeout)}"
      end

      #: () -> String?
      def poll_problem
        poll = @step.poll
        return nil if poll.nil? || poll == false

        timeout = poll.is_a?(Hash) ? poll[:timeout_ms] : nil
        unless poll.is_a?(Hash) && (poll.keys - %i[timeout_ms settled]).empty? && timeout.is_a?(Numeric) && (!timeout.is_a?(Float) || timeout.finite?) && timeout.positive? && timeout <= MAX_TIMEOUT_MS
          return "poll must be false or { timeout_ms, settled? } with a number of milliseconds greater than 0 and at most #{MAX_TIMEOUT_MS}; got #{ClaimRules.describe(poll)}"
        end
        return "poll re-runs observe, and the step has no observe. Values from earlier steps do not change between readings" unless @observe

        nil
      end
    end
  end
end
