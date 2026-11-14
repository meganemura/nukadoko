# frozen_string_literal: true

require "open3"
require "tmpdir"
require "fileutils"
require "securerandom"
require "timeout"

# What a command-line scenario needs: scratch directories that live as long
# as one scenario, and a way to run the program under test that keeps every
# run for the step record. Both are engine-built, so a step never removes a
# directory it made or forgets to note a process it started.
module Nukadoko
  # Runs a command and gives what it left: the exit code (nil when a signal
  # ended it), the signal, stdout, and stderr. Inside a step the run is
  # noted in the step record's processes, with what changed under `cwd`
  # while it ran, which the result gives as `files` too; `files: true`
  # measures that outside a step as well. `env` is added to the runner's
  # environment. A run that `timeout` seconds stopped raises, since it has
  # no exit code to read.
  def self.run_command(command, args = [], cwd: Dir.pwd, env: {}, stdin: nil, timeout: nil, files: false)
    recording = Engine::Processes.current
    cwd = File.expand_path(cwd)
    before = Engine::FileWalk.snapshot(cwd) if recording || files
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    # A group of its own, so its close tells whether anything it started still runs.
    stdout, stderr, status, timed_out = Engine::Processes.spawn(env.transform_keys(&:to_s), [command, *args], cwd, stdin, timeout, group: !recording.nil?)
    duration = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round
    changes = Engine::FileWalk.difference(before, Engine::FileWalk.snapshot(cwd)) if before
    signal = status.termsig && "SIG#{Signal.signame(status.termsig)}"
    recording&.push(
      { command: [command, *args], cwd: cwd, exit_code: status.exitstatus, signal: signal, timed_out: timed_out || nil,
        group: (Engine::Processes.group_state(status.pid) if Engine::Processes.groups?), duration_ms: duration, files: changes,
        env: Engine::Processes.env_entry(env) }.compact.merge(output: { stdout: stdout, stderr: stderr, stdin: stdin })
    )
    raise Timeout::Error, "#{command} did not finish in #{timeout} seconds, so it has no exit code" if timed_out

    { exitCode: status.exitstatus, signal: signal, stdout: stdout, stderr: stderr, **(changes ? { files: changes } : {}) }
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

      def self.groups? = !Gem.win_platform?

      # Runs the command to its close, its stdin closed after `input`.
      def self.spawn(env, argv, cwd, input, timeout, group:)
        options = { chdir: cwd }
        options[:pgroup] = true if group && groups?
        Open3.popen3(env, *argv, **options) do |stdin, out, err, thread|
          stdin.write(input.to_s)
          stdin.close
          readers = [Thread.new { out.read }, Thread.new { err.read }]
          timed_out = timeout && !thread.join(timeout)
          if timed_out
            begin
              Process.kill("TERM", group && groups? ? -thread.pid : thread.pid)
            rescue Errno::ESRCH
              nil
            end
          end
          status = thread.value
          [readers[0].value.to_s.force_encoding("UTF-8"), readers[1].value.to_s.force_encoding("UTF-8"), status, timed_out]
        end
      end

      # `ended` when no process of the group still runs as the leader closed.
      def self.group_state(pid)
        Process.kill(0, -pid)
        "running"
      rescue Errno::ESRCH, Errno::EPERM
        "ended"
      end

      # The child's environment against the runner's: every name the step
      # set, and a value only when it cannot be a credential.
      def self.env_entry(env)
        return { inherited: true } if env.empty?

        added = {}
        changed = {}
        env.each do |name, value|
          name = name.to_s
          (ENV.key?(name) ? changed : added)[name] = shown_value(value.to_s)
        end
        { added: added, changed: changed, removed: [] }
      end

      def self.shown_value(value)
        safe = (value.start_with?("/") && !value.match?(/[[:cntrl:]]/) && File.exist?(value)) || value.match?(/\A-?\d+\z/) || %w[true false].include?(value)
        safe ? value : { hidden_bytes: value.bytesize }
      end
    end

    # A directory's files as their identities, before and after something
    # wrote there, and the difference as the record names it.
    module FileWalk
      SKIPPED = %w[node_modules .git .nukadoko].freeze
      LIMIT = 20_000

      def self.snapshot(dir)
        entries = {}
        skipped = []
        walk = lambda do |at, relative|
          Dir.each_child(at) do |name|
            path = File.join(at, name)
            stat = File.lstat(path)
            if stat.directory? && SKIPPED.include?(name)
              skipped << "#{relative}#{name}/"
              next
            end
            key = "#{relative}#{name}#{"/" if stat.directory?}"
            entries[key] = [stat.size, stat.mtime.to_r, stat.ctime.to_r, stat.ino]
            return :too_many if entries.size > LIMIT

            walk.(path, key) if stat.directory?
          rescue Errno::ENOENT
            nil
          end
        end
        return { unmeasured: "#{dir} holds more than #{LIMIT} entries" } if walk.(dir, "") == :too_many

        { entries: entries, skipped: skipped.sort }
      rescue SystemCallError => e
        { unmeasured: "#{dir} could not be read: #{e.message}" }
      end

      def self.difference(before, after)
        return { unmeasured: before[:unmeasured] || after[:unmeasured] } if before[:unmeasured] || after[:unmeasured]

        b = before[:entries]
        a = after[:entries]
        { added: (a.keys - b.keys).sort, changed: (a.keys & b.keys).reject { a[_1] == b[_1] || _1.end_with?("/") }.sort,
          removed: (b.keys - a.keys).sort, **(after[:skipped].any? ? { skipped: after[:skipped] } : {}) }
      end
    end

    # The `scratch` fixture: `dir` makes a fresh directory, and the engine
    # removes every one of them when the scenario ends, passed or failed.
    class Scratch
      def initialize
        @dirs = []
      end

      # A directory under the system's temporary directory, named
      # `<prefix>-` and six characters, as the TypeScript engine names it.
      def dir(prefix = "nukadoko-scratch")
        raise ArgumentError, "a scratch prefix cannot hold a path separator: #{prefix}" if prefix.match?(%r{[/\\]})

        path = File.join(File.realpath(Dir.tmpdir), "#{prefix}-#{SecureRandom.alphanumeric(6)}")
        Dir.mkdir(path, 0o700)
        @dirs << path
        path
      rescue Errno::EEXIST
        retry
      end

      def dirs = @dirs.dup

      FILE_TEXT = 8 * 1024
      STEP_TEXT = 64 * 1024

      # Each scratch directory's paths as identities, to compare a step's
      # start with its end.
      def snapshot = @dirs.to_h { [_1, FileWalk.snapshot(_1)] }

      # What the step changed in the scratch directories, absolute and
      # sorted, each file with its size and text after the step: a
      # directory made during the step is compared with an empty one. The
      # step reads at most 64 KiB of content in all, 8 KiB of each file.
      def changes(before)
        budget = STEP_TEXT
        @dirs.flat_map do |dir|
          after = FileWalk.snapshot(dir)
          earlier = before.fetch(dir, { entries: {}, skipped: [] })
          next [] if after[:unmeasured] || earlier[:unmeasured]

          diff = FileWalk.difference(earlier, after)
          root = dir.end_with?("/") ? dir : "#{dir}/"
          own = before.key?(dir) ? [] : [{ path: root, change: "added" }]
          own + %i[added changed removed].flat_map { |change| diff[change].map { [_1, change] } }.map do |relative, change|
            path = "#{root}#{relative}"
            next { path: path, change: change.to_s } if change == :removed || relative.end_with?("/")

            size = File.size(path)
            read = [size, FILE_TEXT, budget].min
            budget -= read
            bytes = File.binread(path, read).to_s
            text = bytes.dup.force_encoding("UTF-8")
            content = if read < [size, FILE_TEXT].min then { text: "", bytes: size, truncated: true }
                      elsif !text.valid_encoding? then { bytes: size, binary: true }
                      else { text: text, bytes: size, **(size > read ? { truncated: true } : {}) }
                      end
            { path: path, change: change.to_s, bytes: size, content: content }
          end
        end.sort_by { _1[:path] }
      end

      def remove_all
        @dirs.each { FileUtils.rm_rf(_1) }
      end
    end
  end
end
