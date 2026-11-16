# frozen_string_literal: true
# rbs_inline: enabled

require "time"
require "timeout"

# The fixtures a step body uses to say where it went, to wait for a state
# that is not there yet, and to keep evidence only it can produce. The
# TypeScript engine gives the same three on ctx. Each one fills a list the
# engine writes into the step record, also when the step raises, because a
# failed step is the one whose record a reader opens.
module Nukadoko
  # poll gave up: the budget ended before the block returned a value.
  class PollTimeoutError < StandardError
    attr_reader :timeout_ms #: Numeric
    attr_reader :description #: String?

    #: (Numeric, String?) -> void
    def initialize(timeout_ms, description)
      @timeout_ms = timeout_ms
      @description = description
      super("poll timed out after #{timeout_ms}ms#{" while waiting for #{description}" if description}")
    end
  end

  # A timeout or interval that cannot be a budget. Raised before the first
  # attempt, so it is not in the record: there is no attempt to count.
  class InvalidPollOptionsError < ArgumentError; end

  # An evidence name that would land outside the step's directory.
  class InvalidEvidenceNameError < ArgumentError; end

  # An evidence name the engine itself writes into the step's directory.
  class ReservedEvidenceNameError < ArgumentError; end

  # A pageAs name that cannot be part of a file name.
  class InvalidContextNameError < ArgumentError; end

  # A pageAs call that asks an open context for options it was not made with.
  class ContextOptionsConflictError < ArgumentError; end

  module Engine
    #: () -> String
    def self.now_iso = Time.now.utc.iso8601(3)

    # `section.("label")` marks that the body reached a stage. It is a bare
    # marker, not a block wrapper, so nesting and an early return need no
    # meaning: the record answers where the body stopped.
    class Sections
      attr_reader :entries #: Array[Hash[Symbol, String]]

      #: () -> void
      def initialize
        @entries = []
      end

      #: (String | Symbol) -> nil
      def call(label)
        @entries << { label: label.to_s, at: Engine.now_iso }
        nil
      end
    end

    # `poll.(description:, timeout:, interval:) { value or nil }` calls the
    # block until it gives a value other than nil. The budget holds the
    # attempt in flight too, so a value that arrives after it is not
    # returned. Every finished call is kept, so the record tells a wait that
    # did nothing from one that took seconds.
    class Polls
      DEFAULT_TIMEOUT_MS = 30_000
      DEFAULT_INTERVAL_MS = 500
      # The longest timer Node accepts, kept so both engines refuse the same values.
      MAX_MS = 2_147_483_647

      # An Exception, not a StandardError, so a block that rescues its own
      # errors cannot swallow the end of its budget.
      class AttemptOver < Exception; end

      attr_reader :entries #: Array[Hash[Symbol, untyped]]

      #: () -> void
      def initialize
        @entries = []
      end

      #: [T] (?description: String?, ?timeout: Numeric?, ?interval: Numeric?) { () -> T? } -> T
      def call(description: nil, timeout: nil, interval: nil, &block)
        raise ArgumentError, "poll needs a block that returns nil until the state exists" unless block

        timeout_ms = timeout || DEFAULT_TIMEOUT_MS
        seconds = budget(timeout_ms, "timeout")
        pause = budget(interval || DEFAULT_INTERVAL_MS, "interval")
        started = monotonic
        at = Engine.now_iso
        attempts = 0
        outcome = "resolved"
        over = lambda do
          outcome = "timed_out"
          raise PollTimeoutError.new(timeout_ms, description)
        end
        begin
          loop do
            left = seconds - (monotonic - started)
            over.() unless left.positive?
            attempts += 1
            value = begin
              Timeout.timeout(left, AttemptOver) { block.call } #: untyped
            rescue AttemptOver
              over.()
            rescue StandardError
              outcome = "failed"
              raise
            end
            return value unless value.nil?

            left = seconds - (monotonic - started)
            over.() if left < pause
            sleep(pause)
          end
        ensure
          @entries << { description: description, at: at, attempts: attempts,
                        waited_ms: ((monotonic - started) * 1000).round, outcome: outcome }.compact
        end
      end

      private

      # The budget in seconds, from milliseconds.
      #: (untyped, String) -> Float
      def budget(value, option)
        # A String or a Complex is not a number of milliseconds, so it reads as NaN.
        number = value.is_a?(Numeric) && value.real? ? (_ = value).to_f : Float::NAN #: Float
        return number / 1000 if number.finite? && number.positive? && number <= MAX_MS

        raise InvalidPollOptionsError, "poll #{option} must be a finite number of milliseconds greater than 0 and " \
                                       "at most #{MAX_MS} (got #{value.inspect})"
      end

      #: () -> Float
      def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    # `evidence.attach(name, body)` writes a file into the step's own
    # directory, and `evidence.path(name)` gives a path there without
    # writing. A name used twice keeps both files. A name that differs only
    # by case counts as the same, since a case-insensitive volume would put
    # the two on one file.
    class Evidence
      # The files and directories the engine writes into the same directory.
      HARNESS = %w[record.json final.png trace.zip requests.zip http.jsonl mcp.jsonl websocket.jsonl
                   program-log.txt program-log-late.txt events.jsonl events-late.jsonl events-read.jsonl judged].freeze
      PROCESS_FILE = /\Aprocess-[1-9][0-9]*\.((stdout|stderr|stdin)\.txt|json)\z/
      NAMED_FILE = /\A(?:trace\.[a-z0-9][a-z0-9-]{0,63}\.zip|final\.[a-z0-9][a-z0-9-]{0,63}\.png)\z/
      MAX_ATTACHMENTS = 100

      #: (String, ?reserved: Array[String]) -> void
      def initialize(dir, reserved: [])
        @dir = dir
        @reserved = reserved
        @used = (HARNESS + reserved).to_h { [_1.downcase, true] }
        @attached = []
        @paths = []
      end

      #: (String | Symbol, String) -> nil
      def attach(name, body)
        file = allocate(name.to_s)
        FileUtils.mkdir_p(@dir)
        File.binwrite(File.join(@dir, file), body)
        @attached << { name: name.to_s, file: file, at: Engine.now_iso }
        nil
      end

      #: (String | Symbol) -> String
      def path(name)
        file = allocate(name.to_s)
        FileUtils.mkdir_p(@dir)
        @paths << { name: name.to_s, file: file }
        File.join(@dir, file)
      end

      # What the step left: its attachments, and each path it wrote to, by
      # time, at most MAX_ATTACHMENTS of them, with the whole count when
      # there were more.
      #: () -> [Array[Hash[Symbol, String]], Integer?]
      def snapshot
        written = @paths.filter_map do |entry|
          full = File.join(@dir, entry[:file])
          { **entry, at: File.mtime(full).utc.iso8601(3) } if File.exist?(full)
        end
        # Ruby's sort is not stable, and two files can share a millisecond.
        all = (@attached + written).each_with_index.sort_by { |entry, index| [entry[:at], index] }.map(&:first)
        [all.first(MAX_ATTACHMENTS), all.size > MAX_ATTACHMENTS ? all.size : nil]
      end

      private

      #: (String) -> String
      def allocate(name)
        if name.empty? || %w[. ..].include?(name) || name.match?(%r{[/\\]})
          raise InvalidEvidenceNameError, %(evidence name #{name.inspect} is not allowed: it must not contain "/" or "\\", ) +
                                          %(and must not be ".", "..", or empty. Every attachment and path is written inside this step's own evidence directory.)
        end
        key = name.downcase
        if (HARNESS + @reserved).any? { _1.downcase == key } || key.match?(PROCESS_FILE) || key.match?(NAMED_FILE)
          raise ReservedEvidenceNameError, "evidence name #{name.inspect} is reserved for a file the engine writes itself " \
                                           "(record.json, final.png, trace.zip, http.jsonl, the program's log lines, the trace.<name>.zip and " \
                                           "final.<name>.png files of a pageAs context, and the process-<n> files of a run_command). " \
                                           "A name that differs only by case is reserved too. Choose a different name."
        end
        unless @used.key?(key)
          @used[key] = true
          return name
        end
        dot = name.rindex(".")
        stem, ext = dot&.positive? ? [name[0...dot].to_s, name[dot..].to_s] : [name, ""]
        counter = 2
        counter += 1 while @used.key?("#{stem}-#{counter}#{ext}".downcase)
        candidate = "#{stem}-#{counter}#{ext}"
        @used[candidate.downcase] = true
        candidate
      end
    end
  end
end
