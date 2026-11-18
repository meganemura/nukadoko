# frozen_string_literal: true
# rbs_inline: enabled

# A step's coarse execution path: what one trace's lines say the program
# did, counted by what each line did and no finer (a write by table and
# op, a job by name and phase, a served request by route and status), and
# the range a count of one entry lies in on a path, by the gaps the trace
# leaves open. Pure. Which lines are the trace's, and reading them, are
# the caller's (Reader#collect folds every line of a world's file when
# the world stops).
#
# PATH_KINDS is the one table of what a path keeps. Its order is the
# order a reader ranks a difference by: what persists outside the process
# first, then the route through it.
#
# A path leaves out what is too fine or too noisy to compare across two
# runs of one criterion: a database read (a query count moves with every
# cache), a `tx` line, a row's ids, and an actor. A write to a table the
# program's tables list marks as bookkeeping or infrastructure stays in
# it, its entry carrying what the table holds, since another reader of
# that table may depend on it.
#
# A count on a path is a range, as a count claim's is. Lines that may be
# any line raise only its upper bound, and a trace that is not whole has
# none, except that the step's own requests are written inside first, so
# under `jobs-pending` alone a request count stays bounded, and a step
# that sent nothing and has no line has an exact empty path.
#
# A writer's own kind (`x_decision`) is in a path after the format's
# kinds, counted by its kind and by the fields the project names, each
# read at a dotted path, and by nothing else: a writer may put an id or a
# time in its own field, which would make every run differ from the last.
#
# An outgoing call's origin on loopback is kept without its port: a test
# run starts the services it calls on free ports, so a key with the port
# would make two runs differ by nothing the program decided.
module Nukadoko
  module Engine
    module Events
      PATH_KINDS = {
        "error" => { fields: %w[class handled], compare: "count" },
        "db" => { fields: %w[table op], compare: "count", writes_only: true },
        "http" => { fields: %w[method origin path status], compare: "count" },
        "job" => { fields: %w[name phase], compare: "count" },
        "request" => { fields: %w[method route status], compare: "count" },
        "flag" => { fields: %w[name side], compare: "seen", condition_premise: true }
      }.freeze #: Hash[String, Hash[Symbol, untyped]]

      PATH_KIND_ORDER = PATH_KINDS.keys.freeze

      NO_OWN_READING = { fields: {}, redact: ->(value) { value } }.freeze #: Hash[Symbol, untyped]

      LOOPBACK_HOSTS = %w[localhost 127.0.0.1 [::1]].freeze
      ORIGIN = %r{\A([A-Za-z][A-Za-z0-9+.-]*://)(\[[^\]]*\]|[^:/\[\]]*)(?::[0-9]*)?\z}

      # Whether a kind is a writer's own.
      #: (untyped) -> bool
      def self.own_kind?(kind) = kind.is_a?(String) && kind.start_with?(EXTENSION_PREFIX) && kind.size > EXTENSION_PREFIX.size

      # The value at a dotted path of a JSON object, nil where it has none.
      #: (Hash[String, untyped], String) -> untyped
      def self.value_at(object, field)
        field.split(".").reduce(object) do |value, segment|
          return nil unless value.is_a?(Hash) && value.key?(segment)

          value[segment]
        end
      end

      # The fields of a key: the format's kinds' in PATH_KINDS order, a
      # writer's own in its key's order.
      #: (Hash[String, untyped]) -> Array[String]
      def self.key_fields(key)
        return key.keys.select { _1.start_with?(EXTENSION_PREFIX) } if own_kind?(key["kind"])

        PATH_KINDS.fetch(key["kind"])[:fields]
      end

      # A key as one text, the same for equal keys: what two paths are
      # joined by.
      #: (Hash[String, untyped]) -> String
      def self.path_key_text(key)
        fields = key_fields(key)
        return JsJson.generate([key["kind"], *fields.flat_map { [_1, key[_1]] }]) if own_kind?(key["kind"])

        JsJson.generate([key["kind"], *fields.map { key[_1] }])
      end

      # Where a kind ranks: PATH_KINDS order, then every writer's own kind.
      #: (String) -> Integer
      def self.kind_rank(kind) = own_kind?(kind) ? PATH_KIND_ORDER.size : PATH_KIND_ORDER.index(kind) || PATH_KIND_ORDER.size

      #: (Hash[String, untyped], Hash[String, untyped]) -> Integer
      def self.by_path_key(left, right)
        (kind_rank(left["kind"]) <=> kind_rank(right["kind"])).nonzero? || (path_key_text(left) <=> path_key_text(right)) || 0
      end

      # The order of a flag's gates: the format's first, in its order,
      # then a word it does not define, then nil.
      #: (String?) -> [Integer, String]
      def self.gate_order(gate)
        known = KINDS.fetch("flag").fetch("gate").values || []
        return [known.size + 1, ""] if gate.nil?

        [known.index(gate) || known.size, gate]
      end

      #: (String?, String?) -> Integer
      def self.by_gate(left, right) = gate_order(left) <=> gate_order(right) || 0

      # An `http` line's origin as a path keeps it: on a loopback host,
      # without its port; any other origin as written.
      #: (String) -> String
      def self.path_origin(origin)
        match = ORIGIN.match(origin)
        return origin unless match && LOOPBACK_HOSTS.include?(match[2].to_s.downcase)

        "#{match[1]}#{match[2]}"
      end

      # The entry a line counts toward, or nil for a line that is not in a
      # coarse path.
      #: (Line) -> Hash[String, untyped]?
      def self.path_key_of(line)
        return nil unless line.event? && PATH_KINDS.key?(line.kind)

        spec = PATH_KINDS.fetch(line.kind.to_s)
        object = line.object || {}
        return nil if spec[:writes_only] && object["op"] == "read"

        key = { "kind" => line.kind, **spec[:fields].to_h { [_1, object[_1]] } }
        key["origin"] = path_origin(key["origin"]) if key["kind"] == "http" && key["origin"].is_a?(String)
        key
      end

      # The key a writer's own line counts toward, by the fields `reading`
      # names for its kind.
      #: (String, Hash[String, untyped], Hash[Symbol, untyped]) -> Hash[String, untyped]
      def self.own_key_of(kind, object, reading)
        fields = reading[:fields][kind] || []
        { "kind" => kind, **fields.sort.to_h { [_1, reading[:redact].(value_at(object, _1))] } }
      end

      # The key alone of an entry, without its count and gates.
      #: (Hash[String, untyped]) -> Hash[String, untyped]
      def self.key_only(entry) = { "kind" => entry["kind"], **key_fields(entry).to_h { [_1, entry[_1]] } }

      #: (Hash[String, untyped]) -> Hash[String, untyped]
      def self.request_key(request) = { "kind" => "request", "method" => request["method"], "route" => request["route"], "status" => request["status"] }

      # One trace's lines, folded into its path in any order.
      class PathFold
        #: (Hash[Symbol, untyped], ?Hash[Symbol, untyped]) -> void
        def initialize(inputs, own = NO_OWN_READING)
          @tally = Tally.new(inputs.merge(selections: []))
          @tables = inputs[:tables] || NO_MARKED_TABLES
          @own = own
          @sent = inputs[:spans].each_with_index.to_h #: Hash[String, Integer]
          @requests = [] #: Array[[Integer, Integer, Hash[String, untyped]]]
          @counted = {} #: Hash[String, Hash[Symbol, untyped]]
          @maybe = 0
        end

        # A readable line whose trace is the fold's.
        #: (Line) -> void
        def owned(line)
          @tally.owned(line)
          @maybe += 1 if %w[undefined-kind unknown-version].include?(line.state)
          if (request = Events.request_of(line))
            span = line.trace&.span
            order = span ? @sent.fetch(span, @sent.size) : @sent.size
            @requests << [order, @requests.size, request.transform_keys(&:to_s)]
            return
          end
          key = if line.state == "extension" && Events.own_kind?(line.kind) then Events.own_key_of(line.kind.to_s, line.object || {}, @own)
                else Events.path_key_of(line)
                end
          return unless key

          entry = @counted[Events.path_key_text(key)] ||= { key: key, count: 0, gates: [] }
          entry[:count] += 1
          flag = Events.flag_of(line)
          entry[:gates] << flag[:gate] if flag && !entry[:gates].include?(flag[:gate])
        end

        # An unreadable line whose text carries the fold's trace id.
        #: () -> void
        def damaged
          @tally.damaged
          @maybe += 1
        end

        # The path of the lines folded so far.
        #: (truncated: bool, replaced: bool) -> Hash[Symbol, untyped]
        def path(truncated:, replaced:)
          entries = @counted.values.sort { |a, b| Events.by_path_key(a[:key], b[:key]) }.map do |entry|
            key = entry[:key]
            next key.merge("count" => entry[:count]) if Events.own_kind?(key["kind"])
            next key.merge("count" => entry[:count], "gates" => entry[:gates].sort { |a, b| Events.by_gate(a, b) }) if key["kind"] == "flag"

            holds = key["kind"] == "db" ? Events.mark_of(@tables, key["table"]) : nil
            key.merge("count" => entry[:count], **(holds ? { "holds" => holds } : {}))
          end
          { requests: @requests.sort_by { [_1[0], _1[1]] }.map(&:last), entries: entries, maybe: @maybe,
            open: @tally.reading(truncated: truncated, replaced: replaced)[:open] }
        end
      end

      # How many lines of `path` reported `key`.
      #: (Hash[Symbol, untyped], Hash[String, untyped]) -> Integer
      def self.count_of(path, key)
        text = path_key_text(key)
        return path[:requests].count { path_key_text(request_key(_1)) == text } if key["kind"] == "request"

        path[:entries].find { path_key_text(_1) == text }&.[]("count") || 0
      end

      # Every key the paths hold, their requests' included, once each, in
      # entry order.
      #: (*Hash[Symbol, untyped]) -> Array[Hash[String, untyped]]
      def self.keys_of(*paths)
        keys = {} #: Hash[String, Hash[String, untyped]]
        paths.each { |path| [*path[:entries].map { key_only(_1) }, *path[:requests].map { request_key(_1) }].each { keys[path_key_text(_1)] = _1 } }
        keys.values.sort { |a, b| by_path_key(a, b) }
      end

      # What the table of `key` holds on `path`, when its entry is marked.
      #: (Hash[Symbol, untyped], Hash[String, untyped]) -> String?
      def self.holds_on(path, key)
        return nil unless key["kind"] == "db"

        text = path_key_text(key)
        path[:entries].find { path_key_text(_1) == text }&.[]("holds")
      end

      # What PATH_KINDS says of a kind, apart from its fields.
      #: (String) -> Hash[Symbol, untyped]
      def self.kind_rule(kind) = own_kind?(kind) ? { compare: "count" } : PATH_KINDS.fetch(kind).except(:fields)

      # The gaps that leave a count on `path` unbounded: the trace's,
      # except that a step that sent nothing and has no line has none.
      #: (Hash[Symbol, untyped]) -> Array[Hash[Symbol, untyped]]
      def self.bounding_gaps(path)
        empty = path[:entries].empty? && path[:requests].empty? && path[:maybe].zero?
        return [] if empty && path[:open].size == 1 && path[:open][0][:gap] == "no-requests"

        path[:open]
      end

      # The range the count of `key` on `path` lies in.
      #: (Hash[Symbol, untyped], Hash[String, untyped]) -> Hash[Symbol, Integer?]
      def self.range_on(path, key)
        count = count_of(path, key)
        gaps = bounding_gaps(path)
        bounded = gaps.empty? || (key["kind"] == "request" && gaps.all? { _1[:gap] == "jobs-pending" })
        range = { at_least: count, at_most: bounded ? count + path[:maybe] : nil }
        return range if kind_rule(key["kind"])[:compare] == "count"

        { at_least: [1, count].min, at_most: [1, range[:at_most] || 1].min }
      end
    end
  end
end
