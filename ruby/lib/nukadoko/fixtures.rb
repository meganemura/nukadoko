# frozen_string_literal: true
# rbs_inline: enabled

require "net/http"
require "json"
require "fileutils"
require "time"
require "timeout"

# Fixtures are built by the engine, not the step, so what they record is
# measured: every request a step sends goes through Request and lands in the
# step's http.jsonl as it was sent and answered.
module Nukadoko
  module Engine
    Response = Data.define(
      :status, #: Integer
      :headers, #: Hash[String, Array[String]]
      :body, #: String
    )

    class Response
      #: () -> untyped
      def json = JSON.parse(body)
      #: () -> bool
      def ok? = status.between?(200, 299)
    end

    class Request
      attr_reader :log #: Array[Hash[Symbol, untyped]]

      # `base_url` is the world's URL, which a path joins onto; a project with
      # no program has none. An absolute URL, http or https, goes where it
      # names, so a step can call a third-party API and still have its
      # requests recorded.
      #: (String?) -> void
      def initialize(base_url)
        @base = base_url && URI(base_url)
        @log = []
      end

      #: (String) -> URI::Generic
      def target(path)
        named = URI(path.to_s)
        return named if named.absolute?
        raise ArgumentError, %(The request fixture needs an absolute URL for "#{path}": this world has no program, so there is no base URL to join a path onto) unless @base

        URI.join(@base.to_s, path.to_s)
      end

      BODY_TEXT = 16 * 1024

      #: (Float) -> Integer
      def self.since(started) = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round

      # A body as http.jsonl keeps it: its text, at most 16 KiB, and its
      # size; none when there was none.
      #: (Symbol, String?) -> Hash[Symbol, untyped]
      def self.body(name, bytes)
        return {} if bytes.nil? || bytes.empty?

        raw = bytes.b
        text = raw.byteslice(0, BODY_TEXT).to_s.force_encoding("UTF-8")
        text = text.scrub("") if raw.bytesize > BODY_TEXT
        return { name => { bytes: raw.bytesize, binary: true } } unless text.valid_encoding?

        { name => { text: text, bytes: raw.bytesize, **(raw.bytesize > BODY_TEXT ? { truncated: true } : {}) } }
      end

      %w[get post put patch delete].each do |verb|
        # `data:` is sent as JSON; `body:` is sent as it is, for a request
        # whose body is meant to be wrong.
        define_method(verb) do |path, data: nil, body: nil, headers: {}|
          # @type self: Request
          uri = target(path)
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
            res = HttpRecording.unrecorded { Net::HTTP.start(uri.host.to_s, uri.port, use_ssl: uri.scheme == "https") { _1.request(req) } }
          rescue StandardError => e
            @log << entry.merge(status: 0, duration_ms: Request.since(started), via: "request", **stamp, **Request.body(:request_body, req.body),
                                error: e.message.lines.first.to_s.chomp)
            ::Kernel.raise e
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
      # `secrets` gives the run's loaded secrets when a screenshot is taken,
      # since an environment's env files are read after the browser is made.
      #: (String?, ?Hash[Symbol, untyped], ?secrets: ^() -> Secrets) -> void
      def initialize(base_url, launch_options = {}, secrets: -> { Secrets.new })
        @base_url = base_url
        @launch_options = launch_options
        @secrets = secrets
      end

      # Opaque, so a masked secret leaves no trace of its glyphs.
      MASK_COLOR = "#000000"

      # Locators for every element of `page`, in every frame, that shows a
      # loaded secret: as text, or as the value of an input or textarea, which
      # is not text `get_by_text` reads, and a step may have typed the secret
      # there. The text redaction of a record cannot reach pixels, and
      # marking or rewriting the elements would change the page the next step
      # reads. Only the value as written is found, not an encoded spelling;
      # `get_by_text` ignores case, which costs pixels, never a leak.
      #: (untyped) -> Array[untyped]
      def secret_masks(page)
        values = @secrets.call.shown_values.select { _1.length >= Secrets::MIN_LENGTH }
        return [] if values.empty?

        page.frames.flat_map do |frame|
          fields = frame.locator("input, textarea")
          held = fields.evaluate_all("(elements) => elements.map((element) => String(element.value ?? ''))") #: Array[String]
          values.map { frame.get_by_text(_1) } + held.each_index.select { |index| values.any? { held[index].include?(_1) } }.map { fields.nth(_1) }
        end
      end

      # A screenshot of `page` at `path` with what shows a secret covered,
      # true once written. No screenshot rather than one that shows a
      # secret: masks not found by `deadline` (a monotonic time) give none,
      # and the image is written only once it arrived. `bounded` holds the
      # screenshot to the deadline too, as a pause and a judged view do.
      #: (untyped, String, Float, ?caret: String?, ?bounded: bool) -> bool
      def masked_shot(page, path, deadline, caret: nil, bounded: true)
        masks = Timeout.timeout([deadline - monotonic, 0.001].max) { secret_masks(page) }
        left = ((deadline - monotonic) * 1000).floor
        return false if bounded && left <= 0

        image = page.screenshot(mask: masks, maskColor: MASK_COLOR, **(bounded ? { timeout: left } : {}), **(caret ? { caret: caret } : {}))
        File.binwrite(path, image)
        true
      rescue StandardError, Timeout::Error
        false
      end

      #: (String, Array[Hash[Symbol, untyped]]) -> [untyped, ^() -> void]
      def page_for(step_dir, log)
        require "playwright"
        # playwright-ruby-client parses each driver message from a buffer in
        # the default external encoding. Under US-ASCII (LANG unset) its reader
        # thread dies on the first non-ASCII byte and the step waits forever.
        # exe/nuka sets UTF-8, but a run started another way (a Rake task, a
        # script that calls the CLI) reaches here without it.
        Encoding.default_external = Encoding::UTF_8 unless @execution
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
      attr_writer :step #: Hash[Symbol, untyped]?

      # Which requests to the world the page had finished receiving the
      # response of, and which were in flight, around a claim step's
      # reading: an order of the events this process received, never a
      # claim that the page drew from a response. Only a document, a
      # fetch, and an XMLHttpRequest count; an EventSource stays open, so
      # it would be in flight on every reading.
      #: (untyped) -> void
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
      #: [T] () { () -> T } -> T
      def reading
        started = monotonic
        value = yield
        @reading = [started, monotonic]
        value
      ensure
        @reading ||= [started, monotonic] if started
      end

      #: () -> nil
      def begin_step = (@reading = nil)

      # A claim step's `pages`, `page_requests`, and `judged_view`, after
      # the reading its claims were judged on, when a page was open.
      #: (String, String, ?aria_in_claims: bool) -> Hash[Symbol, untyped]
      def judged(dir, step_record_id, aria_in_claims: false)
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
        # What the pages had received is of requests to a world, so a run
        # with none keeps the view alone.
        received = @base_url ? { pages: [page], page_requests: listed.map { request_record(_1, step_record_id) } } : {}
        { **received, judged_view: view(dir, ended, aria_in_claims) }
      rescue StandardError
        {}
      end

      #: (Hash[Symbol, untyped], String) -> Hash[Symbol, untyped]
      def request_record(entry, step_record_id)
        # @type var trace: String?
        trace = begin
          entry[:request].header_value("traceparent") if entry[:finished] || entry[:failed_at]
        rescue StandardError
          nil
        end
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
      #: (String, Float, bool) -> Hash[Symbol, untyped]
      def view(dir, ended, aria_in_claims)
        @context.tracing.group(TraceActions::JUDGED_VIEW_GROUP)
        view_files(dir, ended, aria_in_claims)
      ensure
        @context.tracing.group_end rescue nil
      end

      # A step whose claims judge a tree nukadoko took keeps that tree in its
      # claims, so the view takes no second one.
      #: (String, Float, bool) -> Hash[Symbol, untyped]
      def view_files(dir, ended, aria_in_claims)
        FileUtils.mkdir_p(File.join(dir, "judged"))
        title = (@page.title rescue nil)
        shot = if masked_shot(@page, File.join(dir, "judged", "page.png"), monotonic + VIEW_TIMEOUT_MS / 1000.0, caret: "initial")
                 { file: "judged/page.png", after_reading_ms: ((monotonic - ended) * 1000).round }
               end
        aria = aria_in_claims ? nil : begin
          tree = @page.aria_snapshot(mode: "ai")
          File.write(File.join(dir, "judged", "page.aria.yml"), tree.end_with?("\n") ? tree : "#{tree}\n")
          { file: "judged/page.aria.yml", after_reading_ms: ((monotonic - ended) * 1000).round }
        rescue StandardError
          nil
        end
        { pages: [{ as: nil, page: 1, url: @page.url, title: title, screenshot: shot, aria: aria }], **(aria_in_claims ? { aria_in_claims: true } : {}) }
      end

      #: () -> Float
      def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)


      # A page's documents, fetches, and XMLHttpRequests to the world get
      # the running step's traceparent through the Chrome DevTools
      # Protocol's Fetch domain, on a session of the page's own: a header set
      # on the whole context would reach other origins too, and a route
      # turns the browser's cache off. Images, scripts, and stylesheets are
      # left out, since each paused request costs a round trip. A session
      # that cannot be opened leaves the page's requests unstamped.
      #: (untyped) -> void
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

      # How long a pause waits for each capture of the page's view. A page
      # whose main thread is stuck answers none of them, and without a
      # deadline the pause would never reach the person.
      VIEW_TIMEOUT_MS = 5_000

      # What `nuka run --step` shows at a pause, taken while the run waits:
      # a viewport screenshot and an ARIA snapshot of the open page, named
      # under `recorded_as` as run.json names them. From now until
      # `release`, the requests the page sends go to the pause's own
      # http.jsonl, never to the step's record. `[]` when no page is open.
      #: (String, String) -> Array[Hash[Symbol, untyped]]
      def hold(dir, recorded_as)
        return [] unless @page

        log = File.join(dir, "http.jsonl")
        @held = lambda do |req|
          File.open(log, "a") { _1.puts JSON.generate({ method: req.method, url: req.url, via: "page" }) }
        rescue StandardError
          nil
        end
        @page.on("request", @held)
        # The caret shows, as the person would see the field they type in.
        shot = masked_shot(@page, File.join(dir, "page.png"), monotonic + VIEW_TIMEOUT_MS / 1000.0, caret: "initial") ? "#{recorded_as}/page.png" : nil
        aria = begin
          tree = @page.aria_snapshot(mode: "ai", timeout: VIEW_TIMEOUT_MS)
          File.write(File.join(dir, "page.aria.yml"), tree.end_with?("\n") ? tree : "#{tree}\n")
          "#{recorded_as}/page.aria.yml"
        rescue StandardError
          nil
        end
        title = (@page.title rescue nil)
        [{ as: nil, page: 1, url: @page.url, title: title, screenshot: shot, aria: aria }]
      end

      # The pause is answered: the page's requests are the next step's again.
      #: () -> void
      def release
        @page.off("request", @held) if @page && @held
        @held = nil
      end

      # Each scenario gets a browser context of its own, so cookies and storage
      # never carry from one scenario to the next.
      # The browser the scenario opened a page in, as run.json names it, or
      # nil when it opened none.
      #: () -> Hash[Symbol, untyped]?
      def scenario_browser
        @context && @browser ? { type: "chromium", version: @browser.version } : nil
      end

      # Closes the scenario's context, and returns the screenshot of its
      # page as the scenario ended, `final.png` in `dir`, when it opened
      # one. A page a failed step left unusable has none, and that costs
      # the screenshot only.
      #: (?String?) -> Array[Hash[Symbol, untyped]]
      def end_scenario(dir = nil)
        shots = [] #: Array[Hash[Symbol, untyped]]
        if dir && @page
          FileUtils.mkdir_p(dir)
          shots << { file: "final.png", at: Time.now.utc.iso8601(3) } if masked_shot(@page, File.join(dir, "final.png"), monotonic + VIEW_TIMEOUT_MS / 1000.0, bounded: false)
        end
        @context&.tracing&.stop
        @context&.close
        @context = @page = nil
        shots
      end

      #: () -> void
      def close
        @browser&.close
        @execution&.stop
      end
    end
  end
end
