# frozen_string_literal: true

require "net/http"
require "json"
require "fileutils"
require "time"

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
            res = HttpRecording.unrecorded { Net::HTTP.start(uri.host, uri.port) { _1.request(req) } }
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
        @context ||= @browser.new_context(baseURL: @base_url).tap do |context|
          context.tracing.start(screenshots: true, snapshots: true)
          watch_requests(context)
        end
        @page ||= @context.new_page.tap { stamp(_1) }
        @context.tracing.start_chunk
        @boundary = Trace.current
        listener = ->(req) { log << { method: req.method, url: req.url, via: "page" } }
        @page.on("request", listener)
        finish = lambda do
          @page.off("request", listener)
          @boundary = nil
          @context.tracing.stop_chunk(path: File.join(step_dir, "trace.zip"))
        end
        [@page, finish]
      end

      STAMPED_TYPES = %w[Document Fetch XHR].freeze
      ORDERED_KINDS = %w[document fetch xhr].freeze

      # The step that runs now, as a page request names it: set for every
      # step, a page or not, so a request a page sends during a step is
      # that step's.
      attr_writer :step

      # Which requests to the world the page had finished receiving the
      # response of, and which were in flight, around a claim step's
      # reading: an order of the events this process received, never a
      # claim that the page drew from a response. Only a document, a
      # fetch, and an XMLHttpRequest count; an EventSource stays open, so
      # it would be in flight on every reading.
      def watch_requests(context)
        @requests = []
        @by_request = {}
        context.on("request", lambda do |request|
          next unless ORDERED_KINDS.include?(request.resource_type) && Trace.stamps?(@base_url, request.url)

          entry = { request: request, method: request.method, url: request.url, sent: monotonic, sent_at: Time.now.utc.iso8601(3), step: @step }
          @requests << entry
          @by_request[request.object_id] = entry
        end)
        context.on("requestfinished", lambda do |request|
          entry = @by_request[request.object_id] or next
          entry.merge!(finished: monotonic, finished_at: Time.now.utc.iso8601(3))
        end)
        context.on("requestfailed", lambda do |request|
          entry = @by_request[request.object_id] or next
          entry.merge!(ended: monotonic, failed_at: Time.now.utc.iso8601(3))
        end)
      end

      # Runs one reading of a claim step and keeps when it began and ended.
      def reading
        started = monotonic
        value = yield
        @reading = [started, monotonic]
        value
      ensure
        @reading ||= [started, monotonic] if started
      end

      def begin_step = (@reading = nil)

      # A claim step's `pages`, `page_requests`, and `judged_view`, after
      # the reading its claims were judged on, when a page was open.
      def judged(dir, step_record_id)
        return {} unless @page && @reading

        started, ended = @reading
        listed = []
        index = lambda do |entry|
          at = listed.index(entry) || (listed << entry).size - 1
          at
        end
        before = @requests.select { _1[:finished] && _1[:finished] < started }.max_by { _1[:finished] }
        open = @requests.select { _1[:sent] <= ended && !(_1[:finished] && _1[:finished] < started) && !(_1[:ended] && _1[:ended] < started) }
        page = { as: nil, page: 1, url: @page.url, last_response: before && index.(before), in_flight: open.map { index.(_1) } }
        { pages: [page], page_requests: listed.map { request_record(_1, step_record_id) }, judged_view: view(dir, ended) }
      rescue StandardError
        {}
      end

      def request_record(entry, step_record_id)
        trace = (entry[:request].header_value("traceparent") if entry[:finished] || entry[:failed_at]) rescue nil
        ids = trace&.match(/\A00-(\h{32})-(\h{16})-\h{2}\z/)
        during = if entry[:step].nil? then "pause"
                 elsif entry[:step][:step_record_id] == step_record_id then "this-step"
                 else "earlier-step"
                 end
        { method: entry[:method], url: entry[:url],
          **(entry[:finished] || entry[:failed_at] ? { trace_id: ids && ids[1], span_id: ids && ids[2] } : {}),
          sent_at: entry[:sent_at], finished_at: entry[:finished_at], **(entry[:failed_at] ? { failed_at: entry[:failed_at] } : {}),
          sent_during: during, **(during == "earlier-step" ? { step: entry[:step] } : {}) }
      end

      # What the page showed right after the judged reading: its title, a
      # viewport screenshot, and its ARIA snapshot, each with how long after
      # the reading it was taken. The claims judged what observe returned,
      # not these files.
      # In a trace group of its own, so the step's actions leave these calls out.
      def view(dir, ended)
        @context.tracing.group(TraceActions::JUDGED_VIEW_GROUP)
        view_files(dir, ended)
      ensure
        @context.tracing.group_end rescue nil
      end

      def view_files(dir, ended)
        FileUtils.mkdir_p(File.join(dir, "judged"))
        title = (@page.title rescue nil)
        shot = begin
          @page.screenshot(path: File.join(dir, "judged", "page.png"))
          { file: "judged/page.png", after_reading_ms: ((monotonic - ended) * 1000).round }
        rescue StandardError
          nil
        end
        aria = begin
          tree = @page.aria_snapshot(mode: "ai")
          File.write(File.join(dir, "judged", "page.aria.yml"), tree.end_with?("\n") ? tree : "#{tree}\n")
          { file: "judged/page.aria.yml", after_reading_ms: ((monotonic - ended) * 1000).round }
        rescue StandardError
          nil
        end
        { pages: [{ as: nil, page: 1, url: @page.url, title: title, screenshot: shot, aria: aria }] }
      end

      def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)


      # A page's documents, fetches, and XMLHttpRequests to the world get
      # the running step's traceparent through the Chrome DevTools
      # Protocol's Fetch domain, on a session of the page's own: a header set
      # on the whole context would reach other origins too, and a route
      # turns the browser's cache off. Images, scripts, and stylesheets are
      # left out, since each paused request costs a round trip. A session
      # that cannot be opened leaves the page's requests unstamped.
      def stamp(page)
        session = @context.new_cdp_session(page)
        session.on("Fetch.requestPaused", lambda do |event|
          request = event["request"]
          headers = nil
          unless request["headers"].keys.any? { _1.downcase == "traceparent" }
            traceparent = @boundary&.stamp(request["url"])
            headers = [*request["headers"].map { |name, value| { name: name, value: value } }, { name: "traceparent", value: traceparent }] if traceparent
          end
          # Answered off the thread that delivers the event, which also
          # reads the answer.
          Thread.new do
            session.send_message("Fetch.continueRequest", params: { requestId: event["requestId"], **(headers ? { headers: headers } : {}) })
          rescue StandardError
            nil
          end
        end)
        world = URI(@base_url)
        patterns = ["#{Trace.origin(world).gsub(/[\\*?]/) { "\\#{_1}" }}/*"]
        patterns << "#{world.scheme}://*.localhost:#{world.port}/*" if world.host == "localhost"
        session.send_message("Fetch.enable", params: { patterns: patterns.product(STAMPED_TYPES).map { |url, type| { urlPattern: url, resourceType: type, requestStage: "Request" } } })
      rescue StandardError
        nil
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
