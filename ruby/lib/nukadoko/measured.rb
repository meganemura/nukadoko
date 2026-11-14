# frozen_string_literal: true

# The `measured` of each claim record: which recorded channel of which step
# record holds exactly the raw value the claim read, as the TypeScript
# engine names it. A claim on a `from` value looks in the record of the step
# that returned it; any other looks in the claim step's own channels. The
# channels are a process's stdout, stderr, and exit code, an HTTP
# response's status and body, and a changed file's content. A number
# channel matches only a number, and a number another channel of the record
# also holds names no channel: content alone cannot tell which one the value
# came from, and nil says less than a source that may be false. So does any
# value while a channel's content is unknown. It is information for a
# reader, never a condition of the claim.
module Nukadoko
  module Engine
    module Measured
      module_function

      # Every channel of a step record, in record order: processes, then
      # HTTP responses, then files. A channel whose content is not on disk
      # whole is unknown.
      def channels(dir, observed, http)
        list = []
        (observed[:processes] || []).each_with_index do |process, index|
          %i[stdout stderr].each do |stream|
            next unless process[stream]

            text = read(File.join(dir, process[stream]))
            list << (text ? { channel: "observed.processes[#{index}].#{stream}", text: text } : { channel: "observed.processes[#{index}].#{stream}", unknown: true })
          end
          list << { channel: "observed.processes[#{index}].exit_code", number: process[:exit_code] } if process[:exit_code].is_a?(Integer)
        end
        if http
          (read(File.join(dir, http)) || "").each_line.with_index do |line, index|
            entry = begin
              JSON.parse(line, symbolize_names: true)
            rescue JSON::ParserError
              next
            end
            list << { channel: "http.jsonl[#{index}].status", number: entry[:status] } if entry[:status].to_i != 0
            list << kept("http.jsonl[#{index}].response_body", entry[:response_body]) if entry[:response_body]
          end
        end
        (observed[:files] || []).each_with_index do |file, index|
          list << kept("observed.files[#{index}].content", file[:content]) if file[:content]
        end
        list
      end

      def kept(channel, text)
        text = { text: text } if text.is_a?(String)
        whole = text[:text] && !text[:truncated] && !text[:incomplete]
        whole ? { channel: channel, text: text[:text] } : { channel: channel, unknown: true }
      end

      def read(path)
        File.read(path, encoding: "UTF-8")
      rescue SystemCallError
        nil
      end

      # The channel of `record_id` that holds `raw`, or nil; `skip` is a
      # channel the other side already matched.
      def channel_for(record_id, raw, channels_of, skip = nil)
        return nil unless record_id

        channels = channels_of.(record_id).reject { skip && skip[:step_record_id] == record_id && skip[:channel] == _1[:channel] }
        return nil if channels.any? { _1[:unknown] }

        match = channels.find { same?(raw, _1) }
        return nil unless match
        return nil if raw.is_a?(Numeric) && channels.any? { !_1.equal?(match) && holds_number?(_1, raw) }

        { step_record_id: record_id, channel: match[:channel] }
      end

      def same?(raw, channel)
        return false if channel[:unknown]
        return raw.is_a?(Numeric) && raw == channel[:number] if channel.key?(:number)
        return raw == channel[:text] if raw.is_a?(String)
        return false if raw.nil?

        JSON.parse(JSON.generate(raw)) == JSON.parse(channel[:text])
      rescue JSON::ParserError
        false
      end

      # Whether a channel holds `n` as a number of its own, not as part of another.
      def holds_number?(channel, number)
        return false if channel[:unknown]
        return channel[:number] == number if channel.key?(:number)

        written = Regexp.escape(number.to_s)
        channel[:text].match?(/(?<![\w.-])#{written}(?![\w.])/)
      end
    end
  end
end
