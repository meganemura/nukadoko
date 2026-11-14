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
      # Version 8 as the TypeScript engine measured it, and version 10 as
      # Playwright 1.65.1 writes it for the Ruby client: the same `before`
      # and `after` fields, with a number for `callId`.
      KNOWN_VERSIONS = [8, 10].freeze
      MAX_ACTIONS = 100
      INTERNAL_WAIT = "__waitInfo__"
      JUDGED_VIEW_GROUP = "nukadoko: view of the judged reading"

      module_function

      # { actions:, truncated: } for the trace at `path`, or nil when there
      # is none.
      def read(path)
        return nil unless File.exist?(path)

        trace = zip_entry(File.binread(path), "trace.trace")
        trace ? parse(trace) : { actions: [] }
      rescue StandardError
        { actions: [] }
      end

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

      def zip_entry(bytes, name)
        eocd = bytes.rindex([0x06054b50].pack("V")) or return nil
        size, offset = bytes.byteslice(eocd + 12, 8).unpack("VV")
        stop = offset + size
        while offset < stop
          return nil unless bytes.byteslice(offset, 4).unpack1("V") == 0x02014b50

          method = bytes.byteslice(offset + 10, 2).unpack1("v")
          compressed = bytes.byteslice(offset + 20, 4).unpack1("V")
          name_size, extra_size, comment_size = bytes.byteslice(offset + 28, 6).unpack("vvv")
          local = bytes.byteslice(offset + 42, 4).unpack1("V")
          if bytes.byteslice(offset + 46, name_size) == name
            local_name, local_extra = bytes.byteslice(local + 26, 4).unpack("vv")
            data = bytes.byteslice(local + 30 + local_name + local_extra, compressed)
            return method.zero? ? data : Zlib::Inflate.new(-Zlib::MAX_WBITS).inflate(data)
          end
          offset += 46 + name_size + extra_size + comment_size
        end
        nil
      end
    end
  end
end
