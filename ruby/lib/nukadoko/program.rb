# frozen_string_literal: true
# rbs_inline: enabled

require "socket"
require "shellwords"
require "net/http"

# How the program under test starts, once per environment: an environment
# is a world of its own, with its own port, directory, and process, so one
# environment's state never reaches another's scenarios.
module Nukadoko
  module Engine
    Environment = Data.define(
      :name, #: String
      :conditions, #: Hash[String, untyped]
      :env, #: Hash[untyped, untyped]
      :env_files, #: Array[String]
    )

    class Program
      #: (Hash[Symbol, untyped]) -> void
      def initialize(options)
        @options = options
      end

      # The worlds a run starts: each --env in the order given; without one,
      # defaultEnvironments in its order, else every environment that
      # declares conditions, else the top level under the name default.
      # default is always a name, whether or not the file defines it.
      #: (?Array[String]) -> Array[Environment]
      def environments(selected = [])
        declared = self.declared
        (selected.any? ? selected : default_names).map do |name|
          unless name == "default" || declared.key?(name)
            add = "add environments.#{name} to the program in nukadoko.config.rb"
            fix = if declared.empty? then "Leave out --env or pass --env default (the program in nukadoko.config.rb defines no other environment), or #{add}."
                  else "Pass --env with a name it accepts (#{["default", *declared.keys].uniq.sort.join(", ")}), or #{add}."
                  end
            raise Refusal.new("unknown-environment", %(Unknown environment "#{name}": not defined in the environments of the program in nukadoko.config.rb), fix: fix)
          end

          environment(name)
        end
      end

      # Whether the config gave a program, so each step names its world.
      #: () -> bool
      def file? = !@options.empty?

      #: () -> Hash[String, untyped]
      def declared = (@options[:environments] || {}).transform_keys(&:to_s)

      #: (String) -> Environment
      def environment(name)
        e = declared[name] || {}
        Environment.new(name, (e[:conditions] || {}).transform_keys(&:to_s), e[:env] || {}, Program.env_files(e))
      end

      # The config's envFiles, then the environment's own: later files win.
      #: (Hash[Symbol, untyped]) -> Array[String]
      def self.env_files(environment) = [*Nukadoko.config_options[:envFiles], *environment[:envFiles]].map(&:to_s)

      #: () -> Array[String]
      def default_names
        return @options[:defaultEnvironments].map(&:to_s) if @options[:defaultEnvironments]

        conditioned = declared.select { |_, e| e[:conditions] }.keys
        conditioned.any? ? conditioned : ["default"]
      end

      # Why a run without --env starts the environments it starts.
      #: () -> String
      def chosen_by
        if @options[:defaultEnvironments] then "defaultEnvironments in nukadoko.config.rb"
        elsif default_names == ["default"] then "no environment declares conditions"
        else "the environments that declare conditions"
        end
      end

      # Started, or StartFailed with the world as far as it got, and the
      # message the run reports as program-start-failed.
      #: (Environment, String, String) -> World
      def start(environment, dir, project)
        serve = @options[:serve]
        port = (serve[:port] == "auto" ? Program.free_port : serve[:port]) if serve
        fill = ->(text) { placeholders(text.to_s, port, dir, environment) }
        # The world's env is what its program and the steps' env fixture get.
        env = (@options[:env] || {}).merge(environment.env).to_h { |k, v| [k.to_s, fill.(v)] }.freeze
        prefix = Trace.new_prefix
        unless serve
          return World.new(base_url: nil, pid: nil, log: nil, env: env, trace_prefix: prefix, log_path: nil, commands: [], timings: {})
        end

        log_path = File.join(dir, "program.log")
        log = File.open(log_path, "w")
        log.sync = true
        # A command is an argv array, or a string split on whitespace, as in
        # the TypeScript engine; neither goes through a shell, so what runs
        # does not depend on the host's shell. A program that needs one
        # writes ["sh", "-c", "..."].
        argv = Program.words(serve[:command]).map { fill.(_1) }
        world = World.new(base_url: "http://localhost:#{port}", pid: nil, log: log, env: env, trace_prefix: prefix, log_path: log_path,
                          commands: [{ phase: "serve", argv: argv }], timings: {})
        begin
          Program.unanswered(port.to_i) unless serve[:port] == "auto"
          log.puts "$ #{Program.display(argv)}"
          started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          begin
            pid = Process.spawn(env, [argv.first, argv.first], *argv.drop(1), out: log, err: log, pgroup: true, chdir: project)
          rescue SystemCallError => e
            raise StartError, "serve command #{Program.display(argv)} could not start: #{e.message}"
          end
          world = world.with(pid: pid)
          world.wait_ready(serve[:ready], serve[:timeout_ms], argv)
          world.timings[:serve_ms] = Request.since(started)
          world
        rescue StartError => e
          world.stop
          tail = File.readlines(log_path).last(20).join.chomp
          message = "the program did not start for world #{environment.name}: #{e.message}#{". The end of #{log_path.delete_prefix("#{project}/")}:\n#{tail}" unless tail.empty?}"
          raise StartFailed.new(message, world, e.message)
        end
      end

      # Why a world did not start, in the TypeScript engine's words.
      class StartError < StandardError; end

      # A world that did not start: the message program-start-failed
      # carries, and the world as far as it got, which run.json names with
      # its cause.
      class StartFailed < StandardError
        attr_reader :world #: World
        attr_reader :cause_text #: String

        #: (String, World, String) -> void
        def initialize(message, world, cause_text)
          super(message)
          @world = world
          @cause_text = cause_text
        end
      end

      # argv as a shell would read it back, for a message and the log.
      #: (Array[String]) -> String
      def self.display(argv) = argv.map { Selection.shell_word(_1) }.join(" ")

      # A command's words: an Array as written, a String split on whitespace.
      #: (String | Array[String]) -> Array[String]
      def self.words(command) = command.is_a?(Array) ? command.map(&:to_s) : command.to_s.split

      #: () -> Integer
      def self.free_port
        server = TCPServer.new("127.0.0.1", 0)
        server.addr[1].tap { server.close }
      end

      # A port the program names is checked before it starts: one something
      # already answers on would send every request to a server nukadoko
      # did not start.
      #: (Integer) -> Integer
      def self.unanswered(port)
        begin
          TCPSocket.new("localhost", port).close
        rescue SystemCallError
          return port
        end
        raise StartError, %(something already answers on port #{port}, so every request would reach a server nukadoko did not start; stop it, or write port: "auto")
      end

      private

      #: (String, Integer?, String, Environment) -> String
      def placeholders(text, port, dir, environment)
        text.gsub("{port}", port.to_s).gsub("{dir}", dir).gsub(/\{condition\.([\w.-]+)\}/) do
          environment.conditions.fetch(Regexp.last_match(1), "").to_s
        end
      end
    end

    # A started program: where it answers, its env, the prefix of every
    # trace id its steps carry, and its log. `timings` gains stop_ms at its stop.
    World = Data.define(
      :base_url, #: String?
      :pid, #: Integer?
      :log, #: File?
      :env, #: Hash[String, String]
      :trace_prefix, #: String
      :log_path, #: String?
      :commands, #: Array[Hash[Symbol, untyped]]
      :timings, #: Hash[Symbol, Integer]
    )

    class World
      # Ready once `path` answers 2xx, as in the TypeScript engine: a 404 or
      # a 503 from a server still starting is not a program that can take
      # requests. A program that exits first, or never answers 2xx within
      # `timeout_ms`, stops the world.
      # A redirect is an answer, not ready: following one would let a ready
      # path that sends the check elsewhere answer for the program.
      #: (String, Integer, Array[String]) -> void
      def wait_ready(path, timeout_ms, argv)
        uri = URI.join(base_url.to_s, path)
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + (timeout_ms / 1000.0)
        last = nil #: String?
        shown = Program.display(argv)
        loop do
          if pid && (status = Process.waitpid2(pid, Process::WNOHANG)&.last)
            exit = status.signaled? ? "on #{Signal.signame(status.termsig.to_i).then { "SIG#{_1}" }}" : "with code #{status.exitstatus}"
            raise Program::StartError, "serve command #{shown} exited #{exit} before #{uri} answered"
          end
          remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
          if remaining <= 0
            raise Program::StartError, "serve command #{shown} did not answer #{uri} with a 2xx status within #{timeout_ms} ms (timeout_ms)#{"; #{last}" if last}"
          end
          begin
            response = Net::HTTP.start(uri.host.to_s, uri.port, open_timeout: [remaining, 2].min, read_timeout: [remaining, 2].min) { _1.get("#{uri.path}#{"?#{uri.query}" if uri.query}") }
            return if response.code.start_with?("2")

            location = response["location"]
            last = if response.code.start_with?("3") && location
                     "the last answer was #{response.code}, a redirect to #{location}, which the ready check does not follow"
                   else "the last answer was #{response.code}"
                   end
          rescue SystemCallError, IOError, Net::OpenTimeout, Net::ReadTimeout
            nil
          end
          sleep 0.1
        end
      end

      #: () -> void
      def stop
        started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        begin
          Process.kill("TERM", -pid) if pid
          Process.wait(pid) if pid
        rescue Errno::ESRCH, Errno::ECHILD, Errno::EPERM
          nil
        end
        log&.close
        timings[:stop_ms] = Request.since(started) if pid
      end
    end
  end
end
