# frozen_string_literal: true
# rbs_inline: enabled

require "json"
require "fileutils"

# The execution events a served world's program appends to the file
# `{events}` names (docs/execution-events.md, docs/spec.md "Execution
# events"): each step's slice of them, written beside its record when the
# step ends, and, once the world has stopped, the world's redacted copy
# and each step's lines that arrived after its record. Boundary: owns no
# file (the program writes it, Program makes and removes it), and decides
# nothing a line says (Events, Selection, Tally do).
#
# A line belongs to the step whose trace id its parsed `trace` field
# holds, never to one whose id merely appears in its text: a value inside
# an event can hold an id too. An unreadable line has no owner, so no
# step's events take data from it; when its text carries a step's trace
# id by the program log's rule, the step's slice counts it as damage to
# its trace, and the line is kept only in the world's copy.
#
# The program writes the file directly, not through a pipe nukadoko
# redacts, so only redacted copies reach the run directory: each line is
# parsed, redacted with the step's secrets, and written again as JSON, so
# a copy is JSON wherever a secret was, and a record shows exactly what
# was read. An unreadable line has no object to redact, so its text is
# redacted as the program log's is.
#
# The file nukadoko made is the one read. A file that is replaced, or made
# shorter, while the scenarios run is no longer read, and every step from
# then on says so (`file-replaced`), since what it read may be incomplete.
#
# A step that stamped a request, or gave a process its trace, reads the
# file as it waits, as the program log's slice does (Trace::Log): until no
# line of its own has arrived for QUIET seconds after the later of its
# last such line and the moment it ended, and no longer than SETTLE.
module Nukadoko
  module Engine
    module Events
      SLICE_FILE = "events.jsonl"
      LATE_FILE = "events-late.jsonl"
      WORLD_FILE = "events.jsonl"
      # The most one of a step's files holds; a step whose lines come to
      # more keeps the first of them, marked `truncated`.
      SLICE_CAP = 16 * 1024 * 1024
      QUIET = 0.03
      SETTLE = 0.3
      POLL = 0.01
      READ_CHUNK = 1024 * 1024


      # The line as a copy keeps it: the parsed object redacted and written
      # again, or the text redacted when there is no object.
      #: (String, Line, Secrets) -> String
      def self.kept_line(text, line, secrets)
        return secrets.redact_string(text) unless line.readable?

        JsJson.generate(secrets.redact(line.object))
      rescue ArgumentError
        # Two keys that redact to one: the text, redacted, loses neither.
        secrets.redact_string(text)
      end

      # Hands each complete line of `path` from byte `from` to the block,
      # with the byte it starts at, a chunk at a time, and returns the byte
      # after the last complete line: a line still being written is read by
      # the next call. A file that does not exist yet has no lines.
      #: (String, Integer) { (String, Integer) -> void } -> Integer
      def self.each_line(path, from)
        File.open(path, "rb") do |file|
          offset = from
          carry = "".b
          loop do
            chunk = file.pread(READ_CHUNK, offset + carry.bytesize)
            bytes = carry + chunk
            stop = bytes.rindex("\n")
            if stop.nil?
              carry = bytes
              next
            end
            start = 0
            bytes.byteslice(0, stop + 1).to_s.each_line("\n") do |raw|
              yield raw.chomp("\n").force_encoding("UTF-8").scrub, offset + start
              start += raw.bytesize
            end
            offset += stop + 1
            carry = bytes.byteslice(stop + 1, bytes.bytesize).to_s
          rescue EOFError
            return offset
          end
        end
      rescue SystemCallError
        from
      end

      # A step's process count as a tally reads it: none, all ended, or one
      # that may still send.
      #: (Array[Hash[Symbol, untyped]]?) -> String
      def self.processes_state(processes)
        return "none" if processes.nil? || processes.empty?

        processes.all? { _1[:group] == "ended" } ? "ended" : "unbounded"
      end

      # What a tally needs of a step's trace.
      #: (Trace::Boundary, Array[Hash[Symbol, untyped]]?) -> Hash[Symbol, untyped]
      def self.inputs_of(boundary, processes)
        { spans: boundary.spans.dup, spans_not_kept: [0, boundary.stamped - boundary.spans.size].max, processes: processes_state(processes),
          process_spans: boundary.process_spans.dup }
      end

      # The tally inputs of a recorded slice. The slice's own gaps say what
      # its processes left open: `processes-unbounded` names one that may
      # still send, and `no-requests` a step that ran none and stamped
      # nothing. A step with no gap of either kind that stamped nothing ran
      # processes that all ended.
      #: (Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def self.inputs_of_slice(slice)
        spans = slice[:stamped_spans] || []
        has = ->(word) { (slice[:open] || []).any? { _1[:gap] == word } }
        processes = if has.("processes-unbounded") then "unbounded"
                    elsif has.("no-requests") || slice[:stamped].to_i.positive? then "none"
                    else "ended"
                    end
        { spans: spans, spans_not_kept: [0, slice[:stamped].to_i - spans.size].max, processes: processes, process_spans: slice[:process_spans] || [] }
      end

      # What one of a step's files may still hold, out of SLICE_CAP.
      class Kept
        attr_reader :lines #: Array[String]
        attr_reader :truncated #: bool

        #: () -> void
        def initialize
          @lines = []
          @bytes = 0
          @truncated = false
        end

        #: (String) -> void
        def keep(text)
          size = text.bytesize + 1
          if @truncated || @bytes + size > SLICE_CAP
            @truncated = true
            return
          end
          @bytes += size
          @lines << text
        end

        # Writes the kept lines to `name` in `dir` and returns `name`, or
        # nil when none were kept or the file could not be written.
        #: (String, String) -> String?
        def write(dir, name)
          return nil if @lines.empty?

          FileUtils.mkdir_p(dir)
          File.write(File.join(dir, name), "#{@lines.join("\n")}\n")
          name
        rescue SystemCallError
          nil
        end
      end

      # The events file of one world, read forward as its steps end.
      class Reader
        attr_reader :path #: String
        attr_reader :prefix #: String

        #: (String, String, ^() -> Secrets) -> void
        def initialize(path, prefix, secrets)
          @path = path
          @prefix = prefix
          @secrets = secrets
          @made = identity
          @replaced = @made.nil?
          @offset = @made ? @made[2] : 0
          @producers = {} #: Hash[String, Hash[Symbol, untyped]]
          @kinds = KindsSeen.new
          @kinds_read = 0
        end

        # Whether the file is still the one nukadoko made, asked before each
        # read from `offset`: once it answers false, it always does.
        #: (Integer) -> bool
        def readable?(offset)
          return false if @replaced

          now = identity
          @replaced = now.nil? || now[0] != @made&.[](0) || now[1] != @made&.[](1) || now[2] < offset
          !@replaced
        end

        #: () -> bool
        def replaced? = @replaced

        # The kinds the world's program has reported, through the end of
        # the file as it stands now.
        #: () -> KindsSeen
        def kinds_seen
          @kinds_read = Events.each_line(@path, @kinds_read) { |text, _| @kinds.note(Events.parse_line(text)) } if readable?(@kinds_read)
          @kinds
        end

        # Where the step whose trace is `trace_id` began, nil when this
        # reader sliced no such step.
        #: (String) -> Hash[Symbol, untyped]?
        def producer(trace_id) = @producers[trace_id]

        # Reads what the file gained since the last call and writes the
        # slice of `boundary`'s trace into `dir`.
        #: (String, Trace::Boundary, Array[Hash[Symbol, untyped]]?) -> Hash[Symbol, untyped]
        def slice(dir, boundary, processes)
          inputs = Events.inputs_of(boundary, processes)
          @producers[boundary.trace_id] = { trace_id: boundary.trace_id, from: @offset, inputs: inputs }
          tally = Tally.new(inputs)
          kept = Kept.new
          secrets = @secrets.()
          read_step(boundary.last_stamp_at) do |text|
            line = Events.parse_line(text)
            if !line.readable?
              next false unless Trace.id_in(text, @prefix) == boundary.trace_id

              tally.damaged
              next true
            end
            owner = Events.owner_of(line, @prefix)
            tally.unowned(line) if owner.nil?
            next false unless owner == boundary.trace_id

            tally.owned(line)
            kept.keep(Events.kept_line(text, line, secrets))
            true
          end
          reading = tally.reading(truncated: kept.truncated, replaced: @replaced)
          { trace_id: boundary.trace_id, lines: reading[:lines], file: kept.write(dir, SLICE_FILE), kinds: reading[:kinds], stamped: boundary.stamped,
            stamped_spans: boundary.spans.dup, unreadable: reading[:unreadable], unowned: reading[:unowned], process_spans: boundary.process_spans.dup,
            process_requests: reading[:process_requests], whole: reading[:whole], open: reading[:open] }
        end

        # Once the world stopped: the world's redacted copy at `copy`, each
        # step's lines past its slice in its LATE_FILE, and what the file
        # holds. `steps` maps a trace id to [lines its slice read, its
        # record's directory].
        #: (String, Hash[String, [Integer, String]]) -> Hash[Symbol, untyped]
        def collect(copy, steps)
          secrets = @secrets.()
          counts = { lines: 0, owned: 0, unowned: 0, unreadable: 0 }
          undefined_kinds = Hash.new(0) #: Hash[String, Integer]
          seen = Hash.new(0) #: Hash[String, Integer]
          late = {} #: Hash[String, Hash[Symbol, untyped]]
          late_kept = {} #: Hash[String, Kept]
          copied = true
          out = begin
            FileUtils.mkdir_p(File.dirname(copy))
            File.open(copy, "w")
          rescue SystemCallError
            copied = false
            nil
          end
          Events.each_line(@path, 0) do |text, _|
            line = Events.parse_line(text)
            counts[:lines] += 1
            owner = Events.owner_of(line, @prefix)
            if !line.readable? then counts[:unreadable] += 1
            elsif owner.nil? then counts[:unowned] += 1
            end
            undefined_kinds[line.kind.to_s] += 1 if line.state == "undefined-kind"
            shown = Events.kept_line(text, line, secrets)
            begin
              out&.puts(shown)
            rescue SystemCallError
              copied = false
            end
            next unless owner

            counts[:owned] += 1
            step = steps[owner] or next
            seen[owner] += 1
            next if seen[owner] <= step[0]

            (late_kept[owner] ||= Kept.new).keep(shown)
            late[owner] = { lines: (late.dig(owner, :lines) || 0) + 1 }
          end
          out&.close
          late.each do |id, entry|
            kept = late_kept.fetch(id)
            file = kept.lines.empty? ? nil : append(File.join(steps.fetch(id)[1], LATE_FILE), kept.lines)
            entry[:file] = file
            entry[:truncated] = true if kept.truncated
          end
          { copied: copied, **counts, undefined_kinds: undefined_kinds, late: late }
        end

        private

        #: (String, Array[String]) -> String?
        def append(path, lines)
          FileUtils.mkdir_p(File.dirname(path))
          File.open(path, "a") { _1.write("#{lines.join("\n")}\n") }
          LATE_FILE
        rescue SystemCallError
          nil
        end

        #: () -> [Integer, Integer, Integer]?
        def identity
          stat = File.stat(@path)
          [stat.dev, stat.ino, stat.size]
        rescue SystemCallError
          nil
        end

        #: () -> Float
        def now = Process.clock_gettime(Process::CLOCK_MONOTONIC)

        # Reads what the file gained and hands each line to the block,
        # which answers whether it is the ending step's; then, when the
        # step stamped anything, keeps reading as it waits for the step's
        # lines still on their way (module header).
        #: (Float?) { (String) -> bool } -> void
        def read_step(last_stamp_at, &own)
          last_own = nil #: Float?
          read = lambda do
            next unless readable?(@offset)

            @offset = Events.each_line(@path, @offset) { |text, _| last_own = now if own.(text) }
          end
          read.()
          return unless last_stamp_at

          ended = now
          loop do
            quiet_since = [ended, last_own || 0].max
            break if now - quiet_since >= QUIET || now >= ended + SETTLE

            sleep POLL
            read.()
          end
        end
      end
    end
  end
end
