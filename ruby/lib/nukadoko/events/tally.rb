# frozen_string_literal: true
# rbs_inline: enabled

# What the lines of one trace say about the work they report, folded in
# the order the file holds them: how many there are of each kind, whether
# every request the step sent and every job it enqueued has reported its
# end, and, for each selection a count names, how many lines match, what
# they were (Counted), and how many may. Pure. Which lines are the
# trace's, and reading and redacting them, are the caller's.
#
# The format writes an operation's line when the operation ends, after the
# lines of everything inside it. So a request's line closes what the
# request did, and a job's `perform` line closes that run of the job: the
# work a trace reports is whole once every request the step stamped has
# its line and every job enqueued in the trace has performed. A request's
# line names the span the step put in its `traceparent`, so each one is
# matched to the request that sent it; a line with a bare trace id stands
# for one request. Lines of several processes are in write order, so the
# counts per job are compared, never their order. A run_command process
# is work no count bounds while it may still run, so a trace whose step
# ran one is not whole until it closed with no process of its group left.
#
# A count never drops a line it cannot read as a match or a miss: a line
# that may be any line is counted as one that may match, by its cause, and
# so is a readable line no step owns in the step's window, when it could
# match. A db line whose match depends on its commit state is kept until
# the reading, since a later `tx` line of the trace decides it.
#
# Whether a db line's change persisted is decided from the trace's lines
# alone, as the format states it: a line with `committed` is in that state
# unless a `tx` on its parent chain rolled back, which makes it unknown;
# otherwise the change persisted when every `tx` on its parent chain
# committed and did not when one rolled back; anything else is unknown.
module Nukadoko
  module Engine
    module Events
      # Why a reading of a step's events may not hold everything its work
      # did, in the order a record lists them.
      GAP_WORDS = %w[inlet-unnamed world-unread producer-not-run no-requests processes-unbounded mcp-unbounded no-lines
                     request-unreported jobs-pending kind-unreported unreadable truncated file-replaced].freeze

      # Why a line may match a selection, as a count's `maybe` names it.
      MAYBE_CAUSES = %w[unreadable undefined_kind unknown_version field_unknown holds_unknown commit_unknown unowned].freeze

      TABLE_HOLDS = %w[state bookkeeping infrastructure].freeze

      # The tables of a world whose program names no tables list.
      NO_MARKED_TABLES = { marked: {} }.freeze #: Hash[Symbol, untyped]


      # What `table` holds by `tables`, when it is marked; nil for a table
      # that holds state, or when the list was not read.
      #: (Hash[Symbol, untyped], untyped) -> String?
      def self.mark_of(tables, table)
        return nil if tables[:unread] || !table.is_a?(String)

        tables[:marked][table]
      end

      # What `tables` says of a line a count of `selection` would count:
      # "counted", a holding the count leaves out, or "unknown". Only a db
      # selection that names no table leaves a line out.
      #: (Hash[String, untyped], Line, Hash[Symbol, untyped]) -> String
      def self.table_rule(selection, line, tables)
        return "counted" if selection["kind"] != "db" || selection.key?("table")
        return "counted" unless line.event? && line.kind == "db"
        return "unknown" if tables[:unread]

        table = (line.object || {})["table"]
        return tables[:marked].any? ? "unknown" : "counted" if table == "unknown"

        mark_of(tables, table) || "counted"
      end

      # The gaps of a reading of a selection of `kind`: the trace's, and
      # `kind-unreported` when the world's program reported no line of it.
      #: (Array[Hash[Symbol, untyped]], String, KindsSeen) -> Array[Hash[Symbol, untyped]]
      def self.reading_gaps(open, kind, kinds)
        gaps = kinds.has?(kind) ? open.dup : [*open, { gap: "kind-unreported", kind: kind }]
        gaps.sort_by { GAP_WORDS.index(_1[:gap]) || GAP_WORDS.size }
      end

      # The kinds a world's program has reported so far.
      class KindsSeen
        #: () -> void
        def initialize
          @seen = {} #: Hash[String, bool]
        end

        #: (Line) -> void
        def note(line) = (@seen[line.kind.to_s] = true if line.event?)

        #: (String) -> bool
        def has?(kind) = @seen.key?(kind)
      end

      # Whether a db line's change persisted, from the lines noted so far.
      class CommitIndex
        #: () -> void
        def initialize
          @by_id = {} #: Hash[String, Symbol]
          @parents = {} #: Hash[String, [bool, untyped]]
          @repeated = {} #: Hash[String, bool]
        end

        #: (Line) -> void
        def note(line)
          id = (line.object || {})["id"]
          return unless id.is_a?(String)
          return @repeated[id] = true if @by_id.key?(id)

          @by_id[id] = if %w[undefined-kind unknown-version].include?(line.state) then :unknown
                       elsif line.event? && line.kind == "tx" then (line.object || {})["phase"] == "rollback" ? :rolled_back : :committed
                       else :other
                       end
          object = line.object || {}
          @parents[id] = [object.key?("parent"), object["parent"]]
        end

        # "persisted", "not-persisted", or "unknown".
        #: (Hash[String, untyped]) -> String
        def state_of(object)
          own = object["committed"]
          return "unknown" if object.key?("committed") && ![true, false].include?(own)

          ends = :no_tx
          seen = {} #: Hash[String, bool]
          has_next = object.key?("parent")
          after = object["parent"]
          txs = 0
          loop do
            unless has_next
              ends = txs.positive? ? :committed : :no_tx
              break
            end
            if !after.is_a?(String) || seen[after] || @repeated[after]
              ends = :ambiguous
              break
            end
            seen[after] = true
            found = @by_id[after]
            if found.nil?
              ends = :dangling
              break
            end
            if found == :unknown
              ends = :ambiguous
              break
            end
            if found == :other
              ends = txs.positive? ? :committed : :no_tx
              break
            end
            if found == :rolled_back
              ends = :rolled_back
              break
            end
            txs += 1
            has_next, after = @parents.fetch(after, [false, nil])
          end
          if object.key?("committed")
            return "unknown" if %i[rolled_back ambiguous].include?(ends)

            return own ? "persisted" : "not-persisted"
          end
          return "not-persisted" if ends == :rolled_back
          return "persisted" if ends == :committed

          "unknown"
        end
      end

      # One trace's lines, folded in file order.
      class Tally
        # `inputs`: `spans` (the span ids of the requests the step stamped),
        # `spans_not_kept`, `processes` ("none", "ended", or "unbounded"),
        # `process_spans`, `mcp_spans`, `selections`, and `tables`.
        #: (Hash[Symbol, untyped]) -> void
        def initialize(inputs)
          @inputs = inputs
          @stamped = inputs[:spans].to_h { [_1, true] } #: Hash[String, bool]
          @reported = {} #: Hash[String, bool]
          @process_spans = (inputs[:process_spans] || []).to_h { [_1, true] } #: Hash[String, bool]
          @mcp_spans = (inputs[:mcp_spans] || []).uniq #: Array[String]
          @selections = inputs[:selections] || [] #: Array[Hash[String, untyped]]
          @tables = inputs[:tables] || NO_MARKED_TABLES #: Hash[Symbol, untyped]
          @process_requests = 0
          @bare = 0
          @lines = 0
          @unreadable = 0
          @unowned = 0
          @kinds = Hash.new(0) #: Hash[String, Integer]
          @jobs = {} #: Hash[String, [Integer, Integer]]
          @commits = CommitIndex.new
          @counts = @selections.map { { yes: 0, maybe: MAYBE_CAUSES.to_h { [_1, 0] } } }
          @grouped = @selections.map { Counted::Groups.new(_1["kind"]) }
          @left_out = @selections.map { Counted::Groups.new(_1["kind"]) }
          @awaiting = @selections.map { [] } #: Array[Array[[Hash[String, untyped], String]]]
        end

        # A readable line whose trace is the tally's, in file order.
        #: (Line) -> void
        def owned(line)
          @lines += 1
          @kinds[line.kind.to_s] += 1
          @commits.note(line)
          object = line.object || {}
          @selections.each_with_index do |selection, index|
            match = Selection.match(selection, line)
            next if match == "no"

            rule = Events.table_rule(selection, line, @tables)
            count = @counts[index]
            if match == "commit-state"
              @awaiting[index] << [object, %w[counted unknown].include?(rule) ? rule : "left-out"]
            elsif rule == "counted"
              if match == "yes"
                count[:yes] += 1
                @grouped[index].add(object)
              else count[:maybe][match] += 1
              end
            elsif rule == "unknown" then count[:maybe][match == "yes" ? "holds_unknown" : match] += 1
            elsif match == "yes" then @left_out[index].add(object)
            end
          end
          return unless line.event?

          span = line.trace&.span
          if line.kind == "request"
            if span.nil? then @bare += 1
            elsif @stamped.key?(span) then @reported[span] = true
            elsif @process_spans.key?(span) then @process_requests += 1
            end
          elsif line.kind == "job"
            enqueues, performs = @jobs.fetch(object["job_id"], [0, 0])
            @jobs[object["job_id"]] = object["phase"] == "enqueue" ? [enqueues + 1, performs] : [enqueues, performs + 1]
          end
        end

        # An unreadable line whose text carries the tally's trace id.
        #: () -> void
        def damaged
          @unreadable += 1
          @counts.each { _1[:maybe]["unreadable"] += 1 }
        end

        # A readable line no step owns, written in the step's window.
        #: (Line) -> void
        def unowned(line)
          @unowned += 1
          @selections.each_with_index do |selection, index|
            next if Selection.match(selection, line) == "no"

            @counts[index][:maybe]["unowned"] += 1 if %w[counted unknown].include?(Events.table_rule(selection, line, @tables))
          end
        end

        # What the lines folded so far say, with whether the reader cut the
        # lines it kept and whether the file was replaced under it.
        #: (truncated: bool, replaced: bool) -> Hash[Symbol, untyped]
        def reading(truncated:, replaced:)
          requests = @stamped.size + @inputs[:spans_not_kept].to_i
          unmatched = [0, requests - @reported.size - @bare].max
          pending = @jobs.select { |_, (enqueues, performs)| performs < enqueues }.keys
          silent = requests.positive? && @lines.zero? && @unreadable.zero? && !replaced
          mcp_unbounded = @mcp_spans.count { !@stamped.key?(_1) }
          processes = @inputs[:processes]
          open = [] #: Array[Hash[Symbol, untyped]]
          open << { gap: "no-requests" } if requests.zero? && processes == "none" && @mcp_spans.empty?
          open << { gap: "processes-unbounded" } if processes == "unbounded"
          open << { gap: "mcp-unbounded", calls: mcp_unbounded } if mcp_unbounded.positive?
          open << { gap: "no-lines" } if silent
          open << { gap: "request-unreported", requests: unmatched } if !silent && unmatched.positive?
          open << { gap: "jobs-pending", job_ids: pending } if pending.any?
          open << { gap: "unreadable", lines: @unreadable } if @unreadable.positive?
          open << { gap: "truncated" } if truncated
          open << { gap: "file-replaced" } if replaced
          counts = @selections.each_with_index.map { |selection, index| decided(selection, index) }
          { lines: @lines, kinds: @kinds.dup, unreadable: @unreadable, unowned: @unowned, process_requests: @process_requests,
            whole: open.empty?, open: open, counts: counts }
        end

        private

        #: (Hash[String, untyped], Integer) -> Hash[Symbol, untyped]
        def decided(selection, index)
          count = @counts[index]
          wanted = selection["committed"] == true ? "persisted" : "not-persisted"
          matched = [] #: Array[Hash[String, untyped]]
          out = [] #: Array[Hash[String, untyped]]
          unknown = 0
          holds_unknown = 0
          @awaiting[index].each do |object, as|
            state = @commits.state_of(object)
            if state == "unknown"
              unknown += 1 unless as == "left-out"
            elsif state == wanted
              case as
              when "counted" then matched << object
              when "unknown" then holds_unknown += 1
              else out << object
              end
            end
          end
          maybe = count[:maybe].merge("holds_unknown" => count[:maybe]["holds_unknown"] + holds_unknown, "commit_unknown" => count[:maybe]["commit_unknown"] + unknown)
          { yes: count[:yes] + matched.size, maybe: maybe, counted: @grouped[index].groups(matched),
            left_out: @left_out[index].groups(out).map { _1.merge(holds: Events.mark_of(@tables, _1[:fields]["table"])) } }
        end
      end
    end
  end
end
