# frozen_string_literal: true
# rbs_inline: enabled

require "net/http"

# Requests a step sends through Net::HTTP itself, without the `request`
# fixture, measured as the TypeScript engine measures a step's own `fetch`:
# each lands in the step's http.jsonl with `via: "net/http"`, and one to
# the world's origin carries the step's traceparent. It records only while
# a step runs, on the thread that runs it, so a fixture's setup, the
# engine's own readiness check, and the `request` fixture (which records
# its requests itself) go through Net::HTTP untouched.
module Nukadoko
  module Engine
    module HttpRecording
      #: [T] (Array[untyped]) { () -> T } -> T
      def self.collect(log)
        Thread.current[:nukadoko_http] = log
        yield
      ensure
        Thread.current[:nukadoko_http] = nil
      end

      # Net::HTTP as the engine's own code calls it, recording nothing.
      #: [T] () { () -> T } -> T
      def self.unrecorded
        was = Thread.current[:nukadoko_http_off]
        Thread.current[:nukadoko_http_off] = true
        yield
      ensure
        Thread.current[:nukadoko_http_off] = was
      end

      # Prepended to Net::HTTP. `request` calls itself once more when the
      # connection was not started, so only the outermost call records.
      # @rbs module-self Net::HTTP
      module Patch
        #: (Net::HTTPGenericRequest, ?String?) ?{ (Net::HTTPResponse) -> void } -> Net::HTTPResponse
        def request(req, body = nil, &block)
          log = Thread.current[:nukadoko_http]
          return super if log.nil? || Thread.current[:nukadoko_http_off] || Thread.current[:nukadoko_http_inside]

          Thread.current[:nukadoko_http_inside] = true
          url = "#{use_ssl? ? "https" : "http"}://#{address}#{":#{port}" unless port == (use_ssl? ? 443 : 80)}#{req.path}"
          traceparent = req["traceparent"] ? nil : Trace.current&.stamp(url)
          req["traceparent"] = traceparent if traceparent
          stamp = traceparent ? { traceparent: traceparent, traceparent_sent_to: [Trace.origin(URI(url))] } : {}
          sent = body || req.body
          started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          begin
            res = super
          rescue StandardError => e
            log << { method: req.method, url: url, status: 0, duration_ms: Request.since(started), via: "net/http", **stamp,
                     **Request.body(:request_body, sent), error: e.message.lines.first.to_s.chomp }
            raise
          end
          log << { method: req.method, url: url, status: res.code.to_i, duration_ms: Request.since(started), via: "net/http", **stamp,
                   **Request.body(:request_body, sent), **(res.body.is_a?(String) ? Request.body(:response_body, res.body) : {}) }
          res
        ensure
          Thread.current[:nukadoko_http_inside] = false if log && !Thread.current[:nukadoko_http_off]
        end
      end

      Net::HTTP.prepend(Patch)
    end
  end
end
