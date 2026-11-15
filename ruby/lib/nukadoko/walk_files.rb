# frozen_string_literal: true
# rbs_inline: enabled

require "fileutils"
require "json"
require "securerandom"
require "time"

# The files a walk of `nuka run --step` and `nuka step` share, read and
# written from both sides, in the TypeScript engine's layout
# (src/run/walk-files.ts), so either engine's `nuka step` answers either
# engine's walk. Nothing else names these files, and nothing here decides
# anything: Walk says what a state becomes and what a call does next, Run
# says when a step is done, and the CLI prints.
#
# Each file has one writer, so no write needs a lock of its own:
#
#   .nukadoko/walk.lock/<n>        the run of walk n, created exclusively, holding its pid, then `released`
#   .nukadoko/walk.json            the run, replaced whole (written aside, then renamed)
#   <run_dir>/answers/<n>.json     nuka step, created exclusively, never rewritten
#   <run_dir>/pauses/<n>/          the run: the views, and the open page's requests
#   .nukadoko/walks-reported/<n>   nuka step, created exclusively once it printed how walk n ended
#
# A process that holds the lock and is gone (a crash, a SIGKILL) leaves a
# walk.json that is not ended and a pid that is not alive: a reader sees the
# walk as gone, and the next `nuka run --step` takes the lock over. A pid
# check, not a lease a process renews: it needs no clock of its own.
module Nukadoko
  module Engine
    module WalkFiles
      LOCK_DIR = "walk.lock"
      RELEASED = "released"
      STATE_FILE = "walk.json"
      REPORTED_DIR = "walks-reported"
      POLL = 0.1
      STATES = %w[starting running paused ended].freeze

      # The run's side of one walk.
      class Handle
        attr_reader :number

        def initialize(project, dir, number, state, announce)
          @project = project
          @dir = dir
          @number = number
          @state = state
          @announce = announce
          @pauses = []
          @run_dir = nil
          @ended = false
        end

        # The run has its directory and its one scenario.
        def begin(run)
          @run_dir = run[:run_dir]
          apply(kind: "begun", run: run)
        end

        # Writes the pause and waits for its answer. `hold` takes the pause's
        # directory and the path the run records it as, and returns the
        # views of the open page.
        #: (Hash[Symbol, untyped]) { (String, String) -> Array[Hash[Symbol, untyped]] } -> String
        def pause_after(facts)
          raise "a walk pauses only after it began" unless @run_dir

          k = facts[:step]
          recorded_as = "pauses/#{k}"
          pause_dir = File.join(@project, @run_dir, "pauses", k.to_s)
          FileUtils.mkdir_p(pause_dir)
          views = yield(pause_dir, recorded_as)
          pause = { pause: k, of: facts[:of], line: facts[:line], text: facts[:text], step: facts[:step_name], status: facts[:status], record: facts[:record],
                    **(facts[:failure] ? { failure: facts[:failure] } : {}), remaining: facts[:remaining], paused_at: WalkFiles.now, views: views }
          apply(kind: "paused", pause: pause)
          @announce&.call(Walk.pause_lines(@number, pause))
          answer_path = File.join(WalkFiles.answers_dir(@project, @run_dir), "#{k}.json")
          answer = WalkFiles.read_answer(answer_path)
          until answer
            sleep POLL
            answer = WalkFiles.read_answer(answer_path)
          end
          @pauses << { pause: k, line: facts[:line], step_record_id: facts[:step_record_id], paused_at: pause[:paused_at],
                       answered_at: answer[:answered_at], answer: answer[:answer], views: views }
          apply(kind: "answered", pause: k, answer: answer[:answer])
          answer[:answer]
        end

        # run.json's `walk`: each pause so far, and its answer. It names only
        # files that are there when it is written.
        def record
          there = ->(file) { file && @run_dir && File.exist?(File.join(@project, @run_dir, file)) ? file : nil }
          pauses = @pauses.map do |entry|
            views = entry[:views].map { _1.merge(screenshot: there.(_1[:screenshot]), aria: there.(_1[:aria])) }
            http = there.("pauses/#{entry[:pause]}/http.jsonl")
            http ? entry.merge(views: views, http: http) : entry.merge(views: views)
          end
          { pauses: pauses }
        end

        # Records how the walk ended and releases the lock. The first call
        # wins: a signal's cleanup and the run's own end can both reach it.
        def end(finish)
          return if @ended

          @ended = true
          begin
            apply(kind: "ended", end: finish, at: WalkFiles.now)
          ensure
            WalkFiles.release_lock(@dir, @number)
          end
        end

        private

        def apply(event)
          @state = Walk.advance(@state, event)
          WalkFiles.replace_file(File.join(@dir, STATE_FILE), "#{JSON.pretty_generate(@state)}\n")
        end
      end

      module_function

      def now = Time.now.utc.iso8601(3)

      # Whether `pid` is a live process. EPERM is a process this one may
      # not signal, which is alive.
      #: (Integer) -> bool
      def alive?(pid)
        Process.kill(0, pid)
        true
      rescue Errno::EPERM
        true
      rescue Errno::ESRCH, RangeError
        false
      end

      def state_dir(project) = File.join(project, ".nukadoko")

      def answers_dir(project, run_dir) = File.join(project, run_dir, "answers")

      def replace_file(path, text)
        aside = "#{path}.#{Process.pid}.tmp"
        File.write(aside, text)
        File.rename(aside, path)
      end

      # walk.json as one read found it: { state: } (nil for no file), or
      # { unreadable: } with why. walk.json has one writer, so a reader
      # checks only the fields every state carries and trusts the rest.
      #: (String) -> Hash[Symbol, untyped]
      def read_state(path)
        parsed = begin
          JSON.parse(File.read(path, encoding: "UTF-8"), symbolize_names: true)
        rescue Errno::ENOENT
          return { state: nil }
        rescue StandardError => e
          return { unreadable: e.message }
        end
        return { unreadable: "it holds no JSON object" } unless parsed.is_a?(Hash)

        valid = STATES.include?(parsed[:state]) && parsed[:number].is_a?(Integer) && parsed[:pid].is_a?(Integer) &&
                parsed[:target].is_a?(String) && parsed[:started_at].is_a?(String)
        valid ? { state: parsed } : { unreadable: "it holds no walk state" }
      end

      # The whole-number names in a directory, and none when it is missing.
      def numbered(dir)
        Dir.children(dir).grep(/\A\d+\z/).map(&:to_i)
      rescue Errno::ENOENT
        []
      end

      # One past every walk this project recorded, in walk.json or as a
      # reported end, so a walk.json lost cannot give a new walk the number
      # of one whose end a `nuka step` call already printed.
      def highest_recorded(dir)
        stored = read_state(File.join(dir, STATE_FILE))[:state]
        [stored ? stored[:number] : 0, *numbered(File.join(dir, REPORTED_DIR))].max
      end

      # The highest lock file and its holder: a pid, "released", or nil for
      # a file that holds neither. Only a number below the highest is ever
      # removed, so a file gone between the listing and the read means a
      # higher one exists: list again.
      def lock_top(lock_dir)
        100.times do
          walks = numbered(lock_dir)
          return nil if walks.empty?

          walk = walks.max
          text = begin
            File.read(File.join(lock_dir, walk.to_s)).strip
          rescue Errno::ENOENT
            next
          end
          pid = Integer(text, 10, exception: false)
          return { walk: walk, holder: text == RELEASED ? RELEASED : (pid&.positive? ? pid : nil) }
        end
        raise "#{lock_dir} changed on every one of 100 reads"
      end

      # Creates `target` with `text` only when it does not exist. A link is
      # exclusive, and the file appears with its whole text: a process
      # killed between an exclusive create and its write would leave an
      # empty lock no reader could tell from one being written.
      def link_whole(target, text)
        aside = "#{target}.#{Process.pid}.#{SecureRandom.uuid}.tmp"
        File.write(aside, text)
        File.link(aside, target)
        true
      rescue Errno::EEXIST
        false
      ensure
        File.unlink(aside) if aside && File.exist?(aside)
      end

      def remove_quietly(path)
        File.unlink(path)
      rescue Errno::ENOENT
        nil
      end

      # The pid of a live process, not this one, that holds a lock file
      # below `walk`, or nil.
      def live_holder_below(lock_dir, walk)
        numbered(lock_dir).each do |lower|
          next if lower >= walk

          text = begin
            File.read(File.join(lock_dir, lower.to_s)).strip
          rescue Errno::ENOENT
            next
          end
          pid = Integer(text, 10, exception: false)
          return pid if pid&.positive? && pid != Process.pid && alive?(pid)
        end
        nil
      end

      # The lock is a directory with one file per walk that took it, named
      # by the walk's number; the highest number holds it. A run takes the
      # lock by creating the next number, so it never removes a file
      # another process may hold: of two runs that find the same holder
      # dead or released, only one creates the next number. A file is
      # removed only once a higher one exists, and only by the process that
      # created that higher one, or by its own creator giving way.
      def take_lock(dir)
        lock_dir = File.join(dir, LOCK_DIR)
        FileUtils.mkdir_p(lock_dir)
        3.times do
          top = lock_top(lock_dir)
          # A holder that is this process is a walk it left without ending:
          # not a second walk.
          holder = top && top[:holder]
          return { holder: holder } if holder.is_a?(Integer) && holder != Process.pid && alive?(holder)

          walk = [top ? top[:walk] : 0, highest_recorded(dir)].max + 1
          file = File.join(lock_dir, walk.to_s)
          next unless link_whole(file, "#{Process.pid}\n")

          if lock_top(lock_dir)&.dig(:walk) != walk
            remove_quietly(file)
            next
          end
          # The number came from a reading that can be old: a live holder
          # below gives this run way.
          if (live = live_holder_below(lock_dir, walk))
            remove_quietly(file)
            return { holder: live }
          end
          numbered(lock_dir).each { remove_quietly(File.join(lock_dir, _1.to_s)) if _1 < walk }
          return { taken: walk }
        end
        { raced: true }
      end

      # The file stays, so the highest number never goes back down; it says
      # `released`, which the next run takes over like a dead pid.
      def release_lock(dir, walk)
        file = File.join(dir, LOCK_DIR, walk.to_s)
        held = begin
          Integer(File.read(file).strip, 10, exception: false)
        rescue Errno::ENOENT
          return
        end
        replace_file(file, "#{RELEASED}\n") if held == Process.pid
      end

      # An answer file is created exclusively and written in one call, so a
      # reader can catch it empty for a moment: that reads as not answered
      # yet, and the next poll reads it whole.
      def read_answer(path)
        value = JSON.parse(File.read(path, encoding: "UTF-8"), symbolize_names: true)
        return nil unless value.is_a?(Hash) && %w[next stop].include?(value[:answer]) && value[:answered_at].is_a?(String)

        { answer: value[:answer], answered_at: value[:answered_at] }
      rescue StandardError
        nil
      end

      # Starts the run's side of a walk: takes the lock, which numbers the
      # walk one past every walk recorded, and writes it as starting. A
      # Handle, or { refused: } with why. `announce` gets the lines of each
      # pause, outside --json.
      def open(project, target, announce: nil)
        dir = state_dir(project)
        FileUtils.mkdir_p(dir)
        lock = take_lock(dir)
        unless lock[:taken]
          message = if lock[:raced] then "another nuka run --step took the walk lock at the same moment, so this one did not start"
                    else "another walk is in progress in this project: nuka run --step, pid #{lock[:holder]}"
                    end
          return { refused: "walk-in-progress", message: message }
        end
        state = Walk.start({ number: lock[:taken], pid: Process.pid, target: target, started_at: now })
        replace_file(File.join(dir, STATE_FILE), "#{JSON.pretty_generate(state)}\n")
        Handle.new(project, dir, lock[:taken], state, announce)
      end

      # The run directory of the walk that is live now, relative to the
      # project root: a walk running or paused whose pid is alive, nil for
      # none. A walk still starting has no run directory yet, so for it
      # "starting" is returned. `nuka clean` keeps what this names.
      def live_run(project)
        path = File.join(state_dir(project), STATE_FILE)
        read = read_state(path)
        20.times do
          break unless read[:unreadable]

          sleep 0.05
          read = read_state(path)
        end
        raise "#{path} could not be read: #{read[:unreadable]}" if read[:unreadable]

        seen = Walk.see(read[:state], ->(pid) { alive?(pid) })
        return { walk: seen[:number], run_dir: "starting" } if seen[:state] == "starting"
        return { walk: seen[:number], run_dir: seen[:run_dir] } if %w[running paused].include?(seen[:state])

        nil
      end

      def answers_of(project, seen, target)
        return {} if seen[:state] == "none"

        state = seen[:state] == "gone" ? seen[:last] : seen #: Hash[Symbol, untyped]
        run_dir = state[:state] == "starting" ? nil : state[:run_dir]
        return {} unless state[:number] == target && run_dir

        dir = answers_dir(project, run_dir)
        names = begin
          Dir.children(dir)
        rescue SystemCallError
          return {}
        end
        names.each_with_object({}) do |name, answers|
          match = /\A(\d+)\.json\z/.match(name) or next
          answer = read_answer(File.join(dir, name))
          answers[match[1].to_i] = answer[:answer] if answer
        end
      end

      # One empty file per walk whose end a `nuka step` call printed.
      # Created exclusively, so two calls that print the same end leave one
      # file.
      def end_reported?(dir, walk) = File.exist?(File.join(dir, REPORTED_DIR, walk.to_s))

      def mark_end_reported(dir, walk)
        FileUtils.mkdir_p(File.join(dir, REPORTED_DIR))
        File.open(File.join(dir, REPORTED_DIR, walk.to_s), File::WRONLY | File::CREAT | File::EXCL, &:close)
      rescue Errno::EEXIST
        nil
      end

      def write_answer(project, run_dir, pause, answer)
        dir = answers_dir(project, run_dir)
        FileUtils.mkdir_p(dir)
        # Another call may have answered first: the next read of the answers
        # decides whether this call repeats it or contradicts it.
        File.open(File.join(dir, "#{pause}.json"), File::WRONLY | File::CREAT | File::EXCL) do |file|
          file.write("#{JSON.generate({ answer: answer, answered_at: now })}\n")
        end
      rescue Errno::EEXIST
        nil
      end

      # One `nuka step` call: reads walk.json until the walk reaches a state
      # the call can report, writing the call's answer once when the walk
      # waits at its pause. Repeating a call is safe. `timeout` (seconds)
      # bounds the wait: a walk still running then is reported as running,
      # with the call itself as its `do`, and a wait that never found its
      # walk is refused as walk-not-found.
      #: (String, Hash[Symbol, untyped], Numeric, ?alive: ^(Integer) -> bool) -> Hash[Symbol, untyped]
      def step_call(project, call, timeout, alive: ->(pid) { alive?(pid) })
        dir = state_dir(project)
        path = File.join(dir, STATE_FILE)
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
        over = -> { Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline }
        target = nil #: Integer?
        loop do
          read = read_state(path)
          if read[:unreadable]
            raise ".nukadoko/#{STATE_FILE} could not be read for #{timeout.round}s: #{read[:unreadable]}" if over.()

            sleep POLL
            next
          end
          seen = Walk.see(read[:state], alive)
          aim = (target ||= Walk.call_target(call, seen, ->(walk) { end_reported?(dir, walk) }))
          decision = Walk.decide(call, aim, seen, answers_of(project, seen, aim))
          case decision[:kind]
          when "write-answer"
            write_answer(project, decision[:run_dir], call[:pause], call[:answer]) if call[:kind] == "answer"
            next
          when "report"
            reported = decision[:seen]
            mark_end_reported(dir, reported[:last][:number]) if reported[:state] == "gone"
            mark_end_reported(dir, reported[:number]) if reported[:state] == "ended"
            return { kind: "report", report: Walk.report(reported, call), seen: reported }
          when "refuse"
            return { kind: "refuse", code: decision[:code], message: decision[:message], **(decision[:do] ? { do: decision[:do] } : {}) }
          end
          if over.()
            # The walk the call is about, still on its way to a pause.
            if !%w[none gone].include?(seen[:state]) && seen[:number] >= aim
              return { kind: "report", report: Walk.report(seen, call), seen: seen }
            end

            last = case seen[:state]
                   when "none" then nil
                   when "gone" then seen[:last]
                   else seen
                   end
            return { kind: "refuse", code: "walk-not-found", message: Walk.nothing_started_message(call[:kind] == "wait" ? call : { kind: "wait" }, timeout.round, seen),
                     fields: { walk: "none", last: last } }
          end
          sleep POLL
        end
      end
    end
  end
end
