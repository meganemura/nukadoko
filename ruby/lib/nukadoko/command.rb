# frozen_string_literal: true

require "open3"
require "tmpdir"
require "fileutils"

# What a command-line scenario needs: scratch directories that live as long
# as one scenario, and a way to run the program under test that keeps every
# run for the step record. Both are engine-built, so a step never removes a
# directory it made or forgets to note a process it started.
module Nukadoko
  # Runs a command and gives what it left: the exit code (nil when a signal
  # ended it), stdout, and stderr. Inside a step, the run is noted in the
  # step record's processes.
  def self.run_command(command, args = [], cwd: Dir.pwd, env: {}, stdin: nil)
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    stdout, stderr, status = Open3.capture3(env.transform_keys(&:to_s), command, *args, chdir: cwd, stdin_data: stdin.to_s)
    result = { exitCode: status.exitstatus, stdout: stdout, stderr: stderr }
    Engine::Processes.current&.push(
      command: command, args: args, cwd: File.expand_path(cwd), exit_code: status.exitstatus,
      signal: status.termsig && Signal.signame(status.termsig),
      duration_ms: ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round
    )
    result
  end

  module Engine
    # The processes the running step started, kept per thread so a step
    # that calls run_command from a helper is still measured.
    module Processes
      def self.current = Thread.current[:nukadoko_processes]

      # Fills `into` even when the step raises, so a failed step still names
      # the processes it ran.
      def self.collect(into)
        Thread.current[:nukadoko_processes] = into
        yield
      ensure
        Thread.current[:nukadoko_processes] = nil
      end
    end

    # The `scratch` fixture: `dir` makes a fresh directory, and the engine
    # removes every one of them when the scenario ends, passed or failed.
    class Scratch
      def initialize
        @dirs = []
      end

      def dir(prefix = "nukadoko-scratch")
        raise ArgumentError, "a scratch prefix cannot hold a path separator: #{prefix}" if prefix.match?(%r{[/\\]})

        Dir.mktmpdir(prefix).tap { @dirs << _1 }
      end

      def dirs = @dirs.dup

      def remove_all
        @dirs.each { FileUtils.rm_rf(_1) }
      end
    end
  end
end
