# frozen_string_literal: true
# rbs_inline: enabled

require "securerandom"
require "uri"

# The W3C trace context the engine puts on what a step sends to the world,
# and the program's log read back by it, as the TypeScript engine does it.
# Each step gets one trace id; each request to the world's origin, and
# each process run_command starts, gets a span id of its own under it. A
# line of program.log belongs to the step whose trace id it carries,
# wherever it appears: every trace id of one world starts with the same
# eight characters, so the id a line carries is the first place where
# those begin 32 hexadecimal ones, and no list of ids is needed to read it.
module Nukadoko
  module Engine
    module Trace
      PREFIX_LENGTH = 8
      ID_LENGTH = 32
      MAX_SPANS = 1000

      #: () -> String
      def self.new_prefix = SecureRandom.hex(PREFIX_LENGTH / 2)

      # W3C reserves an id of all zeros as invalid, so one is drawn again.
      #: (String) -> String
      def self.new_id(prefix)
        loop do
          id = prefix + SecureRandom.hex((ID_LENGTH - prefix.size) / 2)
          return id unless id.match?(/\A0+\z/)
        end
      end

      #: () -> String
      def self.new_span
        loop do
          span = SecureRandom.hex(8)
          return span unless span.match?(/\A0+\z/)
        end
      end

      #: (String, String) -> String
      def self.traceparent(trace_id, span) = "00-#{trace_id}-#{span}-01"

      # The trace id of the world `prefix` names that `line` carries, or nil.
      #: (String, String) -> String?
      def self.id_in(line, prefix)
        text = line.downcase
        at = text.index(prefix)
        while at
          return nil if at + ID_LENGTH > text.size

          id = text[at, ID_LENGTH].to_s
          return id if id.match?(/\A\h{#{ID_LENGTH}}\z/)

          at = text.index(prefix, at + 1)
        end
        nil
      end

      #: (URI::Generic) -> String
      def self.origin(uri) = "#{uri.scheme}://#{uri.host}#{":#{uri.port}" unless uri.port == uri.default_port}"

      # Only the world's origin gets the header: a third party's server may
      # answer a header it did not expect differently. A world at localhost
      # also answers at each name below localhost on the same port.
      #: (untyped, untyped) -> bool
      def self.stamps?(world, target)
        target = URI(target.to_s)
        world = URI(world.to_s)
        return true if origin(target) == origin(world)

        world.host == "localhost" && target.host.to_s.end_with?(".localhost") && target.scheme == world.scheme && target.port == world.port
      rescue URI::Error
        false
      end

      # The step that runs now, kept per thread as the processes are.
      #: () -> Boundary?
      def self.current = Thread.current[:nukadoko_trace]

      #: [T] (Boundary?) { () -> T } -> T
      def self.within(boundary)
        Thread.current[:nukadoko_trace] = boundary
        yield
      ensure
        Thread.current[:nukadoko_trace] = nil
      end

      # One step's trace: what it stamped, and when it last did.
      class Boundary
        attr_reader :trace_id #: String
        attr_reader :origin #: String
        attr_reader :stamped #: Integer
        attr_reader :spans #: Array[String]
        attr_reader :process_spans #: Array[String]
        attr_reader :last_stamp_at #: Float?

        #: (String, String) -> void
        def initialize(trace_id, origin)
          @trace_id = trace_id
          @origin = origin
          @stamped = 0
          @spans = []
          @process_spans = []
          @last_stamp_at = nil
        end

        # The traceparent a request to `url` goes out with, or nil when it
        # is not the world's.
        #: (untyped) -> String?
        def stamp(url)
          return nil unless Trace.stamps?(@origin, url)

          span = Trace.new_span
          @stamped += 1
          @last_stamp_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          @spans << span if @spans.size < MAX_SPANS
          Trace.traceparent(@trace_id, span)
        end

        # A process's TRACEPARENT is not a stamped request: nothing waits
        # for the request it may send, but the log is read a little longer.
        #: () -> String
        def process_traceparent
          span = Trace.new_span
          @last_stamp_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          @process_spans << span if @process_spans.size < MAX_SPANS
          Trace.traceparent(@trace_id, span)
        end
      end

      # program.log read forward as the steps run: each step takes the
      # complete lines written since the last step read, keeps those that
      # carry its trace id, and, when it stamped anything, waits until the
      # log has been quiet for 30 ms (at most 300 ms) for lines still on
      # their way.
      class Log
        SLICE_FILE = "program-log.txt"
        LATE_FILE = "program-log-late.txt"
        QUIET = 0.03
        SETTLE = 0.3
        POLL = 0.01
        KEPT = 16 * 1024 * 1024

        attr_reader :path #: String
        attr_reader :prefix #: String

        #: (String, String) -> void
        def initialize(path, prefix)
          @path = path
          @prefix = prefix
          @offset = File.size?(path).to_i
        end

        #: (String, Boundary) -> Hash[Symbol, untyped]
        def slice(dir, boundary)
          kept = []
          bytes = 0
          truncated = false
          last_own = nil
          read = lambda do
            each_new_line do |line|
              next unless Trace.id_in(line, @prefix) == boundary.trace_id

              last_own = now
              if bytes + line.bytesize + 1 > KEPT
                truncated = true
              else
                bytes += line.bytesize + 1
              end
              kept << line
            end
          end
          read.()
          if boundary.last_stamp_at
            ended = now
            loop do
              quiet_since = [ended, last_own || 0].max
              break if now - quiet_since >= QUIET || now >= ended + SETTLE

              sleep POLL
              read.()
            end
          end
          lines = kept.size
          file = nil
          if lines.positive?
            text = +""
            kept.each { |line| text.bytesize + line.bytesize + 1 > KEPT ? break : text << line << "\n" }
            File.write(File.join(dir, SLICE_FILE), text)
            file = SLICE_FILE
          end
          { trace_id: boundary.trace_id, lines: lines, file: file, stamped: boundary.stamped, **(truncated ? { truncated: true } : {}) }
        end

        # Once the world stopped: how many lines carry a trace id of the
        # world, and each step's lines that its slice did not read, written
        # beside its record. `steps` maps a trace id to [lines read, dir].
        #: (Hash[String, Array[untyped]]) -> Hash[Symbol, untyped]
        def late(steps)
          tagged = 0
          seen = Hash.new(0)
          late = {}
          File.foreach(@path) do |line|
            line = line.chomp
            id = Trace.id_in(line, @prefix) or next
            tagged += 1
            step = steps[id] or next
            seen[id] += 1
            next if seen[id] <= step[0]

            File.open(File.join(step[1], LATE_FILE), "a") { _1.puts(line) }
            late[id] ||= { lines: 0, file: LATE_FILE }
            late[id][:lines] += 1
          end
          { tagged: tagged, late: late }
        rescue SystemCallError
          { tagged: tagged, late: late }
        end

        private

        #: () -> Float
        def now = Process.clock_gettime(Process::CLOCK_MONOTONIC)

        # A line still being written, after the last newline, is left for
        # the next read.
        #: () { (String) -> void } -> void
        def each_new_line
          size = File.size?(@path).to_i
          return if size <= @offset

          chunk = File.binread(@path, size - @offset, @offset)
          stop = chunk.rindex("\n") or return
          @offset += stop + 1
          chunk.byteslice(0, stop).to_s.force_encoding("UTF-8").scrub.split("\n", -1).each { yield _1 }
        rescue SystemCallError
          nil
        end
      end
    end
  end
end
