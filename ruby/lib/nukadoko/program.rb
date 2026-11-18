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

      #: (Environment, String, String) -> World
      def start(environment, dir, project)
        port = if @options[:serve]
          server = TCPServer.new("127.0.0.1", 0)
          server.addr[1].tap { server.close }
        end
        fill = ->(text) { placeholders(text.to_s, port, dir, environment) }
        # The world's env is what its program and the steps' env fixture get.
        env = (@options[:env] || {}).merge(environment.env).to_h { |k, v| [k.to_s, fill.(v)] }.freeze
        prefix = Trace.new_prefix
        unless @options[:serve]
          return World.new(base_url: @options[:base_url], pid: nil, log: nil, env: env, trace_prefix: prefix, log_path: nil, commands: [], timings: {})
        end

        log_path = File.join(dir, "program.log")
        log = File.open(log_path, "w")
        command = fill.(@options[:serve][:command])
        started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        pid = Process.spawn(env, command, out: log, err: log, pgroup: true, chdir: project)
        world = World.new(base_url: "http://localhost:#{port}", pid: pid, log: log, env: env, trace_prefix: prefix, log_path: log_path,
                          commands: [{ phase: "serve", argv: Shellwords.split(command) }], timings: {})
        # Without a ready path the program is ready once "/" answers, as in the
        # TypeScript engine, so a serve block needs only its command.
        world.wait_ready(@options[:serve][:ready] || "/")
        world.timings[:serve_ms] = Request.since(started)
        world
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
      :base_url, #: String
      :pid, #: Integer?
      :log, #: File?
      :env, #: Hash[String, String]
      :trace_prefix, #: String
      :log_path, #: String?
      :commands, #: Array[Hash[Symbol, untyped]]
      :timings, #: Hash[Symbol, Integer]
    )

    class World
      #: (String) -> void
      def wait_ready(path)
        uri = URI.join(base_url, path)
        deadline = Time.now + 30
        begin
          Net::HTTP.get_response(uri)
        rescue SystemCallError
          raise "the program did not answer #{uri} within 30s" if Time.now > deadline

          sleep 0.1
          retry
        end
      end

      #: () -> void
      def stop
        started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        begin
          Process.kill("TERM", -pid) if pid
          Process.wait(pid) if pid
        rescue Errno::ESRCH, Errno::ECHILD
          nil
        end
        log&.close
        timings[:stop_ms] = Request.since(started) if pid
      end
    end
  end
end
