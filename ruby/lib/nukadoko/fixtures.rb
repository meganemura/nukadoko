# frozen_string_literal: true

require "net/http"
require "json"

# Fixtures are built by the engine, not the step, so what they record is
# measured: every request a step sends goes through Request and lands in the
# step's http.jsonl as it was sent and answered.
module Nukadoko
  module Engine
    Response = Data.define(:status, :headers, :body) do
      def json = JSON.parse(body)
      def ok? = status.between?(200, 299)
    end

    class Request
      attr_reader :log

      def initialize(base_url)
        @base = URI(base_url)
        @log = []
      end

      BODY_TEXT = 16 * 1024

      def self.since(started) = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round

      # A body as http.jsonl keeps it: its text, at most 16 KiB, and its
      # size; none when there was none.
      def self.body(name, bytes)
        return {} if bytes.nil? || bytes.empty?

        raw = bytes.b
        text = raw.byteslice(0, BODY_TEXT).force_encoding("UTF-8")
        text = text.scrub("") if raw.bytesize > BODY_TEXT
        return { name => { bytes: raw.bytesize, binary: true } } unless text.valid_encoding?

        { name => { text: text, bytes: raw.bytesize, **(raw.bytesize > BODY_TEXT ? { truncated: true } : {}) } }
      end

      %w[get post put patch delete].each do |verb|
        # `data:` is sent as JSON; `body:` is sent as it is, for a request
        # whose body is meant to be wrong.
        define_method(verb) do |path, data: nil, body: nil, headers: {}|
          uri = URI.join(@base, path)
          klass = Net::HTTP.const_get(verb.capitalize)
          req = klass.new(uri, headers)
          if data
            req["content-type"] = "application/json"
            req.body = JSON.generate(data)
          end
          req.body = body if body
          # The world's origin gets the step's traceparent, so the program's
          # log says which step a request came from.
          traceparent = req["traceparent"] ? nil : Trace.current&.stamp(uri)
          req["traceparent"] = traceparent if traceparent
          started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          entry = { method: verb.upcase, url: uri.to_s, **(path.to_s == uri.to_s ? {} : { declared_url: path.to_s }) }
          stamp = traceparent ? { traceparent: traceparent, traceparent_sent_to: [Trace.origin(uri)] } : {}
          begin
            res = Net::HTTP.start(uri.host, uri.port) { _1.request(req) }
          rescue StandardError => e
            @log << entry.merge(status: 0, duration_ms: Request.since(started), via: "request", **stamp, **Request.body(:request_body, req.body),
                                error: e.message.lines.first.to_s.chomp)
            raise
          end
          @log << entry.merge(status: res.code.to_i, duration_ms: Request.since(started), via: "request", **stamp,
                              **Request.body(:request_body, req.body), **Request.body(:response_body, res.body))
          Response.new(res.code.to_i, res.to_hash, res.body.to_s)
        end
      end
    end

    # Opened only for a step whose body names page or context, as in the
    # TypeScript engine. Requests the page sends are recorded by the engine's
    # own listener, and each step gets a trace chunk.
    class Browser
      def initialize(base_url, launch_options = {})
        @base_url = base_url
        @launch_options = launch_options
      end

      def page_for(step_dir, log)
        require "playwright"
        @execution ||= Playwright.create(playwright_cli_executable_path: ENV.fetch("PLAYWRIGHT_CLI", "npx playwright"))
        @browser ||= @execution.playwright.chromium.launch(**@launch_options)
        @context ||= @browser.new_context(baseURL: @base_url).tap { _1.tracing.start(screenshots: true, snapshots: true) }
        @page ||= @context.new_page
        @context.tracing.start_chunk
        listener = ->(req) { log << { method: req.method, url: req.url, via: "page" } }
        @page.on("request", listener)
        [@page, -> { @page.off("request", listener); @context.tracing.stop_chunk(path: File.join(step_dir, "trace.zip")) }]
      end

      # Each scenario gets a browser context of its own, so cookies and storage
      # never carry from one scenario to the next.
      def end_scenario
        @context&.tracing&.stop
        @context&.close
        @context = @page = nil
      end

      def close
        @browser&.close
        @execution&.stop
      end
    end
  end
end
