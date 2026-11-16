# frozen_string_literal: true
# rbs_inline: enabled

require "json"
require "time"
require "zlib"

# A step's trace.zip read back into the step record's `actions`: every
# Playwright call the step made through its page, as the TypeScript engine
# lists them. Only `trace.trace` inside the zip is read, by walking the
# zip's central directory, so no zip library is needed. A trace that cannot
# be read gives no actions rather than failing the step: measuring never
# breaks the execution. A trace format version this build has not measured
# gives none either, since guessing at its shape would turn an unread
# format into a record.
module Nukadoko
  module Engine
    module TraceActions
      # Version 8 as the TypeScript engine measured it, version 9 as
      # Playwright 1.63.0 writes it (the same fields and the same actions as
      # version 8), and version 10 as
      # Playwright 1.65.1 writes it for the Ruby client: the same `before`
      # and `after` fields, with a number for `callId`.
      KNOWN_VERSIONS = [8, 9, 10].freeze
      MAX_ACTIONS = 100
      INTERNAL_WAIT = "__waitInfo__"
      JUDGED_VIEW_GROUP = "nukadoko: view of the judged reading"

      module_function

      # { actions:, truncated: } for the trace at `path`, or nil when there
      # is none.
      #: (String) -> Hash[Symbol, untyped]?
      def read(path)
        return nil unless File.exist?(path)

        trace = zip_entry(File.binread(path), "trace.trace")
        trace ? parse(trace) : { actions: [] }
      rescue StandardError
        { actions: [] }
      end

      #: (String) -> Hash[Symbol, untyped]
      def parse(text)
        header = nil #: Hash[String, untyped]?
        pending = {}
        # The calls nukadoko made for the judged view, and every call under them.
        own = {}
        actions = []
        total = 0
        text.force_encoding("UTF-8").each_line do |line|
          entry = JSON.parse(line) rescue next
          next unless entry.is_a?(Hash) && entry["type"].is_a?(String)

          case entry["type"]
          when "context-options"
            header ||= entry if %w[version wallTime monotonicTime].all? { entry[_1].is_a?(Numeric) }
          when "before"
            next unless entry["method"].is_a?(String) && entry["startTime"].is_a?(Numeric)

            if (entry["method"] == "tracingGroup" && entry["title"] == JUDGED_VIEW_GROUP) || own[entry["parentId"]]
              own[entry["callId"]] = true
              next
            end
            pending[entry["callId"]] = entry
          when "after"
            before = pending.delete(entry["callId"]) or next
            next if before["method"] == INTERNAL_WAIT || !entry["endTime"].is_a?(Numeric) || header.nil?

            total += 1
            actions << action(before, entry, header) if actions.size < MAX_ACTIONS
          end
        end
        return { actions: [] } if header.nil? || !KNOWN_VERSIONS.include?(header["version"])

        { actions: actions, **(total > MAX_ACTIONS ? { truncated: total } : {}) }
      end

      #: (Hash[String, untyped], Hash[String, untyped], Hash[String, untyped]) -> Hash[Symbol, untyped]
      def action(before, after, header)
        params = before["params"].is_a?(Hash) ? before["params"] : {}
        at = Time.at((header["wallTime"] + (before["startTime"] - header["monotonicTime"])) / 1000.0).utc.iso8601(3)
        { method: before["method"],
          **(params["expression"].is_a?(String) ? { expression: params["expression"] } : {}),
          **(params["selector"].is_a?(String) ? { selector: params["selector"] } : {}),
          **(params["url"].is_a?(String) ? { url: params["url"] } : {}),
          **([true, false].include?(params["isNot"]) ? { is_not: params["isNot"] } : {}),
          **(params["timeout"].is_a?(Numeric) ? { timeout_ms: params["timeout"] } : {}),
          ms: (after["endTime"] - before["startTime"]).round, outcome: after.key?("error") ? "failed" : "passed", at: at }
      end

      #: (String, String) -> String?
      def zip_entry(bytes, name)
        eocd = bytes.rindex([0x06054b50].pack("V")) or return nil
        # A cut past the end reads as empty, which fails the checks below.
        cut = ->(at, length) { bytes.byteslice(at, length).to_s }
        u16 = ->(at) { cut.(at, 2).unpack1("v").to_i }
        u32 = ->(at) { cut.(at, 4).unpack1("V").to_i }
        offset = u32.(eocd + 16)
        stop = offset + u32.(eocd + 12)
        while offset < stop
          return nil unless u32.(offset) == 0x02014b50

          method = u16.(offset + 10)
          compressed = u32.(offset + 20)
          name_size = u16.(offset + 28)
          local = u32.(offset + 42)
          if cut.(offset + 46, name_size) == name
            data = cut.(local + 30 + u16.(local + 26) + u16.(local + 28), compressed)
            return method.zero? ? data : Zlib::Inflate.new(-Zlib::MAX_WBITS).inflate(data)
          end
          offset += 46 + name_size + u16.(offset + 30) + u16.(offset + 32)
        end
        nil
      end
    end
  end
end
