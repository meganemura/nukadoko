# frozen_string_literal: true
# rbs_inline: enabled

require "json"

# The execution events line format, version 1 (docs/execution-events.md),
# as data: every kind and every field it defines, and the one function
# that turns a line of text into what the line is. Pure: no I/O, no
# secrets, no clock. Which step a line belongs to is decided from the trace
# id this module reads and the world's prefix the caller passes
# (`owner_of`); what the lines of one trace add up to is Tally's.
#
# A line is an event only when its kind's required fields hold values the
# format allows. A line that breaks that is unreadable, with the reason,
# and so is one that is not one JSON object, repeats a key in one object
# (a parser keeps one of the two values, so a record would show one and
# say nothing), holds an integer past 2^53 - 1 (the TypeScript engine's
# parser rounds it, so an id would change silently there), or has no valid
# `trace` or `kind`. An unreadable line has no owner: no trace id read
# from it is trusted, so no step's events take data from it.
module Nukadoko
  module Engine
    module Events
      FORMAT_VERSION = 1
      DB_OPS = %w[read insert update delete other].freeze
      # The most primary keys one `ids` field holds.
      IDS_CAP = 100
      SAFE = 2**53 - 1
      EXTENSION_PREFIX = "x_"

      # One field of a kind: its type, whether the format requires it,
      # whether it may hold null, and the values a string field may hold.
      Field = Data.define(
        :type, #: Symbol
        :required, #: bool
        :nullable, #: bool
        :values, #: Array[String]?
      )

      # A Data block's methods are its own, but rbs-inline reads only a
      # class body, so they are written in one.
      class Field
        #: (type: Symbol, required: bool, ?nullable: bool, ?values: Array[String]?) -> Field
        def self.of(type:, required:, nullable: false, values: nil) = new(type:, required:, nullable:, values:)
      end

      KINDS = {
        "request" => { "method" => Field.of(type: :string, required: true), "route" => Field.of(type: :string, required: true, nullable: true),
                       "status" => Field.of(type: :integer, required: true), "calls" => Field.of(type: :strings, required: false) },
        "db" => { "table" => Field.of(type: :string, required: true), "op" => Field.of(type: :string, required: true, values: DB_OPS),
                  "rows" => Field.of(type: :integer, required: false, nullable: true), "ids" => Field.of(type: :ids, required: false),
                  "committed" => Field.of(type: :boolean, required: false) },
        "tx" => { "id" => Field.of(type: :string, required: true), "phase" => Field.of(type: :string, required: true, values: %w[commit rollback]) },
        "job" => { "name" => Field.of(type: :string, required: true), "queue" => Field.of(type: :string, required: false),
                   "phase" => Field.of(type: :string, required: true, values: %w[enqueue perform]), "job_id" => Field.of(type: :string, required: true),
                   "calls" => Field.of(type: :strings, required: false) },
        "http" => { "method" => Field.of(type: :string, required: true), "origin" => Field.of(type: :string, required: true),
                    "path" => Field.of(type: :string, required: true), "status" => Field.of(type: :integer, required: true, nullable: true) },
        "flag" => { "name" => Field.of(type: :string, required: true), "side" => Field.of(type: :string, required: true),
                    "gate" => Field.of(type: :string, required: false, values: %w[boolean actor percentage]) },
        "error" => { "class" => Field.of(type: :string, required: true), "handled" => Field.of(type: :boolean, required: true) }
      }.freeze #: Hash[String, Hash[String, Field]]

      # What a line's `trace` field says: the trace id, in lowercase, and
      # the span a whole `traceparent` names, nil for a bare trace id.
      TraceRef = Data.define(
        :trace_id, #: String
        :span, #: String?
      )

      # What one line is: an `event`; an `extension`, a kind the writer
      # made up (`x_`), kept and read for nothing; an `undefined-kind`, a
      # mistake or a later version's kind; an `unknown-version`, whose
      # meaning is not known; or `unreadable`, with why.
      Line = Data.define(
        :state, #: String
        :trace, #: TraceRef?
        :kind, #: String?
        :object, #: Hash[String, untyped]?
        :why, #: String?
      )

      # A Data block's methods are its own, but rbs-inline reads only a
      # class body, so they are written in one.
      class Line
        #: (state: String, ?trace: TraceRef?, ?kind: String?, ?object: Hash[String, untyped]?, ?why: String?) -> Line
        def self.of(state:, trace: nil, kind: nil, object: nil, why: nil) = new(state:, trace:, kind:, object:, why:)

        #: () -> bool
        def readable? = state != "unreadable"

        #: () -> bool
        def event? = state == "event"
      end

      TRACEPARENT = /\A(\h{2})-(\h{32})-(\h{16})-\h{2}\z/
      BARE_TRACE_ID = /\A\h{32}\z/
      ALL_ZEROS = /\A0+\z/

      module_function

      # A W3C `traceparent` (any version but `ff`) or a bare 32-character
      # trace id, in either case, with no id of all zeros; nil otherwise.
      #: (untyped) -> TraceRef?
      def trace_ref_of(value)
        return nil unless value.is_a?(String)

        text = value.downcase
        return text.match?(ALL_ZEROS) ? nil : TraceRef.new(trace_id: text, span: nil) if text.match?(BARE_TRACE_ID)

        match = TRACEPARENT.match(text) or return nil
        version, trace_id, span = match.captures.map(&:to_s)
        return nil if version == "ff" || trace_id.to_s.match?(ALL_ZEROS) || span.to_s.match?(ALL_ZEROS)

        TraceRef.new(trace_id: trace_id.to_s, span: span)
      end

      # The trace id of the step a line belongs to, in a world whose trace
      # ids start with `prefix`, or nil: an unreadable line, or a trace the
      # program made for a request nukadoko did not stamp.
      #: (Line, String) -> String?
      def owner_of(line, prefix)
        id = line.trace&.trace_id
        id&.start_with?(prefix) ? id : nil
      end

      # The first key one object of `text` holds twice, or nil. `text` is
      # JSON that parsed, so every string and bracket is whole.
      #: (String) -> String?
      def repeated_key(text)
        frames = [] #: Array[[Hash[String, bool]?, bool]]
        at = 0
        while at < text.size
          char = text[at]
          if char == '"'
            start = at
            at += 1
            until text[at] == '"'
              at += 1 if text[at] == "\\"
              at += 1
            end
            top = frames.last
            if top && top[0] && top[1]
              key = JSON.parse(text[start..at].to_s)
              return key if top[0].key?(key)

              top[0][key] = true
              top[1] = false
            end
          elsif char == "{" then frames << [{}, true]
          elsif char == "[" then frames << [nil, false]
          elsif char == "}" || char == "]" then frames.pop
          elsif char == ","
            top = frames.last
            top[1] = true if top && top[0]
          end
          at += 1
        end
        nil
      end

      # Whether `value` is one integer JavaScript holds exactly, as a whole
      # float is in its one number type.
      #: (untyped) -> bool
      def safe_integer?(value)
        return value.abs <= SAFE if value.is_a?(Integer)

        value.is_a?(Float) && value.finite? && value == value.floor && value.abs <= SAFE
      end

      # Why `value` does not fit `field`, or nil when it does.
      #: (untyped, Field) -> String?
      def field_problem(value, field)
        return field.nullable ? nil : "is null" if value.nil?

        case field.type
        when :string
          return "is not a string" unless value.is_a?(String)

          field.values && !field.values&.include?(value) ? "is #{JSON.generate(value)}, which is not one of #{field.values&.join(", ")}" : nil
        when :integer then safe_integer?(value) ? nil : "is not an integer"
        when :number then value.is_a?(Numeric) ? nil : "is not a number"
        when :boolean then [true, false].include?(value) ? nil : "is not true or false"
        when :strings then value.is_a?(Array) && value.all?(String) ? nil : "is not an array of strings"
        when :ids
          return "is not an array of strings or integers" unless value.is_a?(Array) && value.all? { _1.is_a?(String) || safe_integer?(_1) }

          value.size > IDS_CAP ? "holds #{value.size} ids, more than #{IDS_CAP}" : nil
        end
      end

      # An integer literal past 2^53 - 1 anywhere in the parsed value.
      #: (untyped) -> bool
      def unsafe_integer?(value)
        case value
        when Integer then value.abs > SAFE
        when Array then value.any? { unsafe_integer?(_1) }
        when Hash then value.each_value.any? { unsafe_integer?(_1) }
        else false
        end
      end

      #: (String) -> Line
      def unreadable(why) = Line.of(state: "unreadable", why: why)

      # Reads one line of a world's events file, without its line feed.
      #: (String) -> Line
      def parse_line(text)
        value = begin
          JsJson.parse(text)
        rescue JSON::ParserError, EncodingError
          return unreadable("is not JSON")
        end
        return unreadable("holds an integer past 2^53 - 1; a writer writes a larger id as a string") if unsafe_integer?(value)
        return unreadable("is not one JSON object") unless value.is_a?(Hash)

        repeated = repeated_key(text)
        return unreadable("holds the key #{JSON.generate(repeated)} twice in one object") if repeated

        trace = trace_ref_of(value["trace"]) or return unreadable("has no trace that is a traceparent or a 32-character trace id")
        kind = value["kind"]
        return unreadable("has no kind") unless kind.is_a?(String) && !kind.empty?
        return Line.of(state: "unknown-version", trace: trace, kind: kind, object: value) if value.key?("v") && !(safe_integer?(value["v"]) && value["v"] == FORMAT_VERSION)
        return Line.of(state: "extension", trace: trace, kind: kind, object: value) if kind.start_with?(EXTENSION_PREFIX)

        fields = KINDS[kind] or return Line.of(state: "undefined-kind", trace: trace, kind: kind, object: value)
        fields.each do |name, field|
          next unless field.required
          return unreadable("is a #{kind} line with no #{name}") unless value.key?(name)

          problem = field_problem(value[name], field)
          return unreadable("is a #{kind} line whose #{name} #{problem}") if problem
        end
        Line.of(state: "event", trace: trace, kind: kind, object: value)
      end

      # The flag a `flag` event reports, `{ name:, side:, gate: }` with the
      # gate nil when the line names none as text; nil for any other line.
      #: (Line) -> Hash[Symbol, untyped]?
      def flag_of(line)
        return nil unless line.event? && line.kind == "flag"

        object = line.object || {}
        { name: object["name"], side: object["side"], gate: object["gate"].is_a?(String) ? object["gate"] : nil }
      end

      # The request a `request` event reports, `{ method:, route:, status: }`.
      #: (Line) -> Hash[Symbol, untyped]?
      def request_of(line)
        return nil unless line.event? && line.kind == "request"

        object = line.object || {}
        { method: object["method"], route: object["route"], status: object["status"] }
      end
    end
  end
end
