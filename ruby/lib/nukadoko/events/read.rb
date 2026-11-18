# frozen_string_literal: true
# rbs_inline: enabled

# A claim step's reading of an earlier step's execution events, at the
# moment its claims are judged: the lines of that step's trace counted
# against each selection, as a range, written to READ_FILE beside the
# reading step's record. Boundary: what a line says and what a count says
# of a claim are Events'; which step produced the events, and the
# deadline, are the caller's; this module reads and waits.
#
# A reading starts at the byte the producer's slice began reading at, so
# it holds every line of the producer's trace, and the lines no step owns
# from then on: such a line may be the producer's, so it widens every
# count it could match. Lines another step owns do not.
#
# The reading waits while the producer's events may still become whole (a
# request with no line yet, a job not yet performed, no line at all). It
# stops once they are whole, once a gap no more lines can close is open,
# or when the deadline is near. It never waits until a claim would hold:
# waiting for "one row was written" would make "nothing was written" hold
# before the write arrived.
#
# A recorded producer (`nuka do --use`) is read from its record's
# directory: the slice and its late lines, read again with the same
# tally. Its lines no step owns were counted in its slice and not kept, so
# each one widens every count by one.
module Nukadoko
  module Engine
    module Events
      READ_FILE = "events-read.jsonl"

      # Gaps more lines can close: the reading waits only while every open
      # gap is one of these.
      CLOSABLE = %w[no-lines request-unreported jobs-pending].freeze

      NO_MAYBE = MAYBE_CAUSES.to_h { [_1, 0] }.freeze

      # One producer's lines, folded for every key that reads it.
      class Group
        attr_reader :producer #: Hash[Symbol, untyped]
        attr_reader :requests #: Array[Hash[Symbol, untyped]]
        attr_reader :tally #: Tally
        attr_accessor :unowned_not_kept #: Integer
        attr_accessor :truncated #: bool
        attr_accessor :replaced #: bool

        #: (Hash[Symbol, untyped], Array[Hash[Symbol, untyped]], Tally) -> void
        def initialize(producer, requests, tally)
          @producer = producer
          @requests = requests
          @tally = tally
          @unowned_not_kept = 0
          @truncated = false
          @replaced = false
        end

        #: () -> String
        def trace_id = @producer[:source] == "live" ? @producer[:start][:trace_id] : @producer[:slice][:trace_id]

        # Whether more lines can no longer change whether the group is whole.
        #: () -> bool
        def settled?
          reading = @tally.reading(truncated: @truncated, replaced: @replaced)
          reading[:whole] || reading[:open].any? { !CLOSABLE.include?(_1[:gap]) }
        end
      end

      #: () -> Float
      def self.clock = Process.clock_gettime(Process::CLOCK_MONOTONIC)

      # Reads each request's producer (`{ key:, producer:, selection: }`),
      # waiting until every live producer's events are whole, can no
      # longer become whole, or `until_at` (monotonic seconds) is near, and
      # writes the lines it counted to READ_FILE in `dir`. Returns each
      # key's reading, as a step record's `events_read` holds it.
      #: (Array[Hash[Symbol, untyped]], Float, String, Secrets) -> Hash[String, Hash[Symbol, untyped]]
      def self.read(requests, until_at, dir, secrets)
        started = clock
        by_producer = {} #: Hash[Hash[Symbol, untyped], Array[Hash[Symbol, untyped]]]
        requests.each { (by_producer[_1[:producer]] ||= []) << _1 unless _1[:producer][:source] == "unread" }
        groups = by_producer.to_h do |producer, keys|
          inputs = producer[:source] == "live" ? producer[:start][:inputs] : inputs_of_slice(producer[:slice])
          [producer.object_id, Group.new(producer, keys, Tally.new(inputs.merge(selections: keys.map { _1[:selection] })))]
        end
        kept = Kept.new
        live_kept = {} #: Hash[Integer, String]
        recorded_kept = [] #: Array[String]
        recorded_kinds = KindsSeen.new
        by_reader = {} #: Hash[Reader, Array[Group]]
        groups.each_value do |group|
          if group.producer[:source] == "live" then (by_reader[group.producer[:reader]] ||= []) << group
          else read_recorded(group, recorded_kinds) { recorded_kept << kept_line(_1, _2, secrets) }
          end
        end
        threads = by_reader.map do |reader, file_groups|
          Thread.new { read_live(file_groups, reader, until_at) { |at, text, line| live_kept[at] ||= kept_line(text, line, secrets) } }
        end
        threads.each(&:join)
        waited = ((clock - started) * 1000).round
        live_kept.keys.sort.each { kept.keep(live_kept.fetch(_1)) }
        recorded_kept.each { kept.keep(_1) }
        file = kept.write(dir, READ_FILE)
        kinds_of = by_reader.keys.to_h { [_1, _1.kinds_seen] }
        requests.to_h do |request|
          producer = request[:producer]
          selection = request[:selection]
          if producer[:source] == "unread"
            next [request[:key], { of: producer[:of], trace_id: nil, count: selection, range: { at_least: 0, at_most: nil }, counted: [], whole: false,
                                   open: [{ gap: producer[:gap] }], maybe: NO_MAYBE.dup, lines: 0, unreadable: 0, unowned: 0, file: nil, waited_ms: 0 }]
          end

          group = groups.fetch(producer.object_id)
          live = producer[:source] == "live"
          truncated = group.truncated || kept.truncated
          reading = group.tally.reading(truncated: truncated, replaced: group.replaced)
          count = reading[:counts][group.requests.index(request) || 0]
          maybe = count[:maybe].merge("unowned" => count[:maybe]["unowned"] + group.unowned_not_kept)
          kinds = live ? kinds_of.fetch(producer[:reader]) : recorded_kinds
          open = reading_gaps(reading[:open], selection["kind"], kinds)
          whole = open.empty?
          [request[:key], { of: producer[:of], trace_id: group.trace_id, count: selection, range: Count.range_of(count[:yes], maybe, whole), counted: count[:counted],
                            **(count[:left_out].empty? ? {} : { left_out: count[:left_out] }), whole: whole, open: open, maybe: maybe,
                            lines: reading[:lines], unreadable: reading[:unreadable], unowned: live ? reading[:unowned] : group.unowned_not_kept,
                            file: file, waited_ms: live ? waited : 0, **(truncated ? { truncated: true } : {}) }]
        end
      end

      # Reads the live groups' world file forward, feeding each group's
      # tally, until every group is settled or `until_at` is near. The block
      # keeps a line some group counted, by its byte.
      #: (Array[Group], Reader, Float) { (Integer, String, Line) -> void } -> void
      def self.read_live(groups, reader, until_at)
        starts = groups.map { _1.producer[:start][:from] }
        offset = starts.min || 0
        replaced = false
        fold = lambda do |text, at|
          line = parse_line(text)
          text_owner = line.readable? ? nil : Trace.id_in(text, reader.prefix)
          owner = owner_of(line, reader.prefix)
          counted = false
          groups.each_with_index do |group, index|
            next if at < starts[index]

            id = group.trace_id
            if !line.readable?
              next unless text_owner == id

              group.tally.damaged
              counted = true
            elsif owner == id
              group.tally.owned(line)
              counted = true
            elsif owner.nil?
              group.tally.unowned(line)
              counted = true if group.requests.any? { Selection.match(_1[:selection], line) != "no" }
            end
          end
          yield at, text, line if counted
        end
        loop do
          if reader.readable?(offset)
            begin
              offset = each_line(reader.path, offset) do |text, at|
                # A line that raised would end the read short of the offset
                # it reached, and the next read would count every line
                # before it again: the one line is left as far as it got.
                fold.(text, at)
              rescue StandardError
                nil
              end
            rescue SystemCallError
              nil
            end
          else
            replaced = true
          end
          groups.each { _1.replaced = replaced }
          break if groups.all?(&:settled?) || clock + POLL >= until_at

          sleep POLL
        end
      end

      # Waits until the step that `start` began is whole, can no longer
      # become whole, or `until_at` is near, and keeps nothing: `nuka do`
      # waits so before it stops its world. A world whose program has
      # written no line yet is not waited for: a program that writes none
      # would cost every call the whole wait.
      #: (Reader, Hash[Symbol, untyped]?, Float) -> void
      def self.settle(reader, start, until_at)
        return unless start && File.size?(reader.path)

        group = Group.new({ source: "live", start: start, reader: reader }, [], Tally.new(start[:inputs].merge(selections: [])))
        read_live([group], reader, until_at) { nil }
      end

      # Folds a recorded producer's lines into its group's tally.
      #: (Group, KindsSeen) { (String, Line) -> void } -> void
      def self.read_recorded(group, kinds)
        producer = group.producer
        slice = producer[:slice]
        [slice[:file], LATE_FILE].compact.each do |name|
          each_line(File.join(producer[:dir], name), 0) do |text, _|
            line = parse_line(text)
            kinds.note(line)
            # A copy holds only the step's own lines, each written again as
            # JSON: one that no longer reads is still one of them.
            if !line.readable? then group.tally.damaged
            elsif line.trace&.trace_id == slice[:trace_id] then group.tally.owned(line)
            else next
            end
            yield text, line
          end
        rescue SystemCallError
          nil
        end
        if producer[:world]
          begin
            each_line(producer[:world], 0) { |text, _| kinds.note(parse_line(text)) }
          rescue SystemCallError
            nil
          end
        end
        slice[:unreadable].to_i.times { group.tally.damaged }
        group.unowned_not_kept = slice[:unowned].to_i
        group.truncated = slice[:open].to_a.any? { _1[:gap] == "truncated" } || producer[:late_truncated] == true
        group.replaced = slice[:open].to_a.any? { _1[:gap] == "file-replaced" }
      end
    end
  end
end
