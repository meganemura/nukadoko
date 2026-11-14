# frozen_string_literal: true

require "socket"
require "net/http"

# How the program under test starts, once per environment: an environment
# is a world of its own, with its own port, directory, and process, so one
# environment's state never reaches another's scenarios.
module Nukadoko
  module Engine
    Environment = Data.define(:name, :conditions, :env)

    class Program
      def initialize(options)
        @options = options
      end

      # The worlds a run starts: each --env in the order given; without one,
      # defaultEnvironments in its order, else every environment that
      # declares conditions, else the top level under the name default.
      # default is always a name, whether or not the file defines it.
      def environments(selected = [])
        declared = self.declared
        (selected.any? ? selected : default_names).map do |name|
          unless name == "default" || declared.key?(name)
            add = "add environments.#{name} to nukadoko.program.rb"
            fix = if declared.empty? then "Leave out --env or pass --env default (nukadoko.program.rb defines no other environment), or #{add}."
                  else "Pass --env with a name it accepts (#{["default", *declared.keys].uniq.sort.join(", ")}), or #{add}."
                  end
            raise Refusal.new("unknown-environment", %(Unknown environment "#{name}": not defined in nukadoko.program.rb's "environments"), fix: fix)
          end

          environment(name)
        end
      end

      def declared = (@options[:environments] || {}).transform_keys(&:to_s)

      def environment(name)
        e = declared[name] || {}
        Environment.new(name, (e[:conditions] || {}).transform_keys(&:to_s), e[:env] || {})
      end

      def default_names
        return @options[:defaultEnvironments].map(&:to_s) if @options[:defaultEnvironments]

        conditioned = declared.select { |_, e| e[:conditions] }.keys
        conditioned.any? ? conditioned : ["default"]
      end

      # Why a run without --env starts the environments it starts.
      def chosen_by
        if @options[:defaultEnvironments] then "defaultEnvironments in nukadoko.program.rb"
        elsif default_names == ["default"] then "no environment declares conditions"
        else "the environments that declare conditions"
        end
      end

      def start(environment, dir, project)
        return World.new(@options[:base_url], nil, nil) unless @options[:serve]

        port = TCPServer.open("127.0.0.1", 0) { _1.addr[1] }
        fill = ->(text) { placeholders(text.to_s, port, dir, environment) }
        env = (@options[:env] || {}).merge(environment.env).to_h { |k, v| [k.to_s, fill.(v)] }
        log = File.open(File.join(dir, "program.log"), "w")
        pid = Process.spawn(env, fill.(@options[:serve][:command]), out: log, err: log, pgroup: true, chdir: project)
        world = World.new("http://127.0.0.1:#{port}", pid, log)
        world.wait_ready(@options[:serve][:ready])
        world
      end

      private

      def placeholders(text, port, dir, environment)
        text.gsub("{port}", port.to_s).gsub("{dir}", dir).gsub(/\{condition\.([\w.-]+)\}/) do
          environment.conditions.fetch(Regexp.last_match(1), "").to_s
        end
      end
    end

    World = Data.define(:base_url, :pid, :log) do
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

      def stop
        Process.kill("TERM", -pid) if pid
        Process.wait(pid) if pid
        log&.close
      rescue Errno::ESRCH, Errno::ECHILD
        log&.close
      end
    end
  end
end
