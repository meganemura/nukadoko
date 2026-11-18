# frozen_string_literal: true
# rbs_inline: enabled

require "delegate"
require "json"

# `Nukadoko.measure_mcp`, which makes the MCP calls a step sends through a
# client's transport part of the step record (docs/spec.md "MCP calls"):
# each request and notification becomes a line of the step's mcp.jsonl
# with the answer it got, and carries the step's trace context in
# `params._meta.traceparent`, so the server's log lines and execution
# events for the call are the step's. It decides no verdict: an `isError`
# result or a JSON-RPC error is an answer the step reads.
#
# It wraps the transport, not the client. The mcp gem's client calls only
# `send_request(request:)`, which returns the answer, and
# `send_notification(notification:)` on its transport, so the wrapper
# measures those two and hands every other method to the transport as it
# is: a project keeps the official client, and nukadoko requires no MCP
# gem.
#
# It finds the step at each send, on the thread that sends, as the
# requests a step sends through Net::HTTP are found. A client is usually
# made in a scenario fixture, outside every step, and called from several
# steps, so a step bound when the transport was wrapped would be the wrong
# one. A message sent outside every step (the client's `initialize`, or a
# request the client sends from a thread of its own) goes as it was given
# and is recorded nowhere.
#
# Over HTTP to the world, the request the transport sends for a call goes
# out with the call's traceparent as its header, and counts as a stamped
# request with the call's span, so the program's `request` line for it
# closes the call. Over stdio no line can close a call: that is the
# `mcp-unbounded` gap.
module Nukadoko
  # `transport`, measured: give it to the MCP client in its place.
  #: [T] (T) -> T
  def self.measure_mcp(transport) = Engine::McpCalls::Measured.new(transport) # steep:ignore

  module Engine
    module McpCalls
      FILE = "mcp.jsonl"

      # The params member that names each method's target, by the line
      # field that keeps it. A method MCP adds later is one more row.
      TARGETS = {
        "tools/call" => [:tool, "name"],
        "prompts/get" => [:prompt, "name"],
        "resources/read" => [:uri, "uri"],
        "resources/subscribe" => [:uri, "uri"],
        "resources/unsubscribe" => [:uri, "uri"],
      }.freeze #: Hash[String, [Symbol, String]]

      #: [T] (Array[Hash[Symbol, untyped]]) { () -> T } -> T
      def self.collect(log)
        Thread.current[:nukadoko_mcp] = log
        yield
      ensure
        Thread.current[:nukadoko_mcp] = nil
      end

      # The call whose transport is sending now: the traceparent its HTTP
      # request takes, and the origins that got it.
      #: () -> Hash[Symbol, untyped]?
      def self.sending = Thread.current[:nukadoko_mcp_sending]

      #: [T] (Hash[Symbol, untyped]) { () -> T } -> T
      def self.sending_as(call)
        Thread.current[:nukadoko_mcp_sending] = call
        yield
      ensure
        Thread.current[:nukadoko_mcp_sending] = nil
      end

      # The header an MCP call's own HTTP request to the world takes: the
      # call's traceparent, so the header and `params._meta` carry one
      # value. Nil outside a call, or to another origin.
      #: (String) -> String?
      def self.traceparent_for(url)
        call = sending
        boundary = Trace.current
        return nil unless call && call[:traceparent] && boundary && Trace.stamps?(boundary.origin, url)

        boundary.mcp_sent(call, Trace.origin(URI(url)))
        call[:traceparent]
      end

      # A member of a message, whichever kind of key it was written with.
      #: (untyped, String) -> untyped
      def self.member(message, key)
        return nil unless message.is_a?(Hash)

        message.key?(key) ? message[key] : message[key.to_sym]
      end

      #: (untyped) -> String?
      def self.traceparent_in(message)
        meta = member(member(message, "params"), "_meta")
        value = member(meta, "traceparent")
        value.is_a?(String) ? value : nil
      end

      # `message` with `traceparent` in `params._meta`, as a new Hash with
      # keys of the kind the message has. A message that already carries a
      # traceparent keeps it, as a request that sets its own header does,
      # and one whose `params` is not a Hash goes as it was: JSON-RPC allows
      # positional params, and an Array has no place for the key.
      #: (Hash[untyped, untyped], String) -> Hash[untyped, untyped]
      def self.stamp(message, traceparent)
        params = member(message, "params")
        return message unless traceparent_in(message).nil? && (params.nil? || params.is_a?(Hash))

        key = message.keys.first.is_a?(Symbol) ? ->(name) { name.to_sym } : ->(name) { name }
        params ||= {}
        meta = member(params, "_meta")
        meta = {} unless meta.is_a?(Hash)
        params = params.except("_meta", :_meta).merge(key.("_meta") => meta.merge(key.("traceparent") => traceparent))
        message.except("params", :params).merge(key.("params") => params)
      end

      # A call as it starts: the message as it goes out, and the
      # traceparent nukadoko gave it, nil when it kept the step's own or
      # the run has no world.
      #: (Hash[untyped, untyped]) -> Hash[Symbol, untyped]
      def self.start(message)
        boundary = Trace.current
        traceparent = boundary&.mcp_traceparent if traceparent_in(message).nil?
        sent = traceparent ? stamp(message, traceparent) : message
        { message: sent, traceparent: traceparent, span: traceparent&.split("-")&.at(2), sent_to: [], counted: false }
      end

      # The mcp.jsonl line of a call and how it ended. The params and the
      # result are their JSON text, kept as a body is; a JSON-RPC error
      # keeps its code and the first line of its message, which can carry
      # a stack. The record redacts the line as it writes it.
      #: (Hash[Symbol, untyped], **untyped) -> Hash[Symbol, untyped]
      def self.line(call, **ended)
        message = call[:message]
        method = member(message, "method").to_s
        id = member(message, "id")
        params = member(message, "params")
        answer = ended[:answer]
        result = member(answer, "result") if answer
        error = member(answer, "error") if answer
        field, param = TARGETS[method]
        target = field && member(params, param.to_s)
        traceparent = traceparent_in(message)
        sent_to = call[:sent_to] #: Array[String]
        { method: method, **(id.is_a?(String) || id.is_a?(Integer) ? { id: id } : {}),
          **(ended[:notification] ? { notification: true } : {}),
          **(target.is_a?(String) && field ? { field => target } : {}),
          **(params.nil? ? {} : { params: kept(params) }),
          **(traceparent ? { traceparent: traceparent } : {}),
          **(sent_to.empty? ? {} : { header_sent_to: sent_to.dup }),
          **(ended.key?(:duration_ms) ? { duration_ms: ended[:duration_ms] } : {}),
          **(answer.is_a?(Hash) && (answer.key?("result") || answer.key?(:result)) ? { result: kept(result) } : {}),
          **(member(result, "isError") == true ? { is_error: true } : {}),
          **(error ? { error: { code: (code = member(error, "code")).is_a?(Integer) ? code : nil, message: member(error, "message").to_s.lines.first.to_s.chomp } } : {}),
          **(ended[:send_error] ? { send_error: ended[:send_error] } : {}) }
      end

      #: (untyped) -> Hash[Symbol, untyped]
      def self.kept(value)
        Request.body(:value, JSON.generate(value))[:value] || { text: "", bytes: 0 }
      rescue JSON::GeneratorError
        { unread: "not JSON text" }
      end

      # The transport, measured. Recording never breaks the call: the
      # transport's own error goes on to the client unchanged.
      class Measured < SimpleDelegator
        #: (request: Hash[untyped, untyped]) ?{ () -> void } -> untyped
        def send_request(request:, &block)
          log = ::Thread.current[:nukadoko_mcp] #: Array[Hash[Symbol, untyped]]?
          return __getobj__.send_request(request: request, &block) unless log && request.is_a?(Hash)

          call = McpCalls.start(request)
          started = ::Process.clock_gettime(Process::CLOCK_MONOTONIC)
          begin
            answer = McpCalls.sending_as(call) { __getobj__.send_request(request: call[:message], &block) }
          rescue StandardError => e
            log << McpCalls.line(call, send_error: e.message.lines.first.to_s.chomp, duration_ms: Request.since(started))
            ::Kernel.raise e
          end
          log << McpCalls.line(call, answer: answer, duration_ms: Request.since(started))
          answer
        end

        # A notification has no answer, so its line is written as it goes.
        #: (notification: Hash[untyped, untyped]) -> untyped
        def send_notification(notification:)
          log = ::Thread.current[:nukadoko_mcp] #: Array[Hash[Symbol, untyped]]?
          return __getobj__.send_notification(notification: notification) unless log && notification.is_a?(Hash)

          call = McpCalls.start(notification)
          log << McpCalls.line(call, notification: true)
          McpCalls.sending_as(call) { __getobj__.send_notification(notification: call[:message]) }
        end
      end
    end
  end
end
