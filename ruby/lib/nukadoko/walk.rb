# frozen_string_literal: true
# rbs_inline: enabled

# A walk of `nuka run --step` as data: the states one walk passes through,
# the one transition the run applies to move it, and what one `nuka step`
# call does next and prints, in the TypeScript engine's shape
# (src/run/walk.ts). Pure: no file system, no clock, no process. WalkFiles
# reads and writes the files both sides share, and Run holds the step that
# pauses.
#
# One walk is one execution of one scenario. Pause k comes after step k, so
# a pause number names the step a person was shown, and an answer names the
# walk and the pause it answers: an answer to a pause nobody was shown, or
# to an earlier walk the same command once answered, is refused, never
# applied to whichever pause is open. Pause numbers only increase, and
# `ended` absorbs every later event, so a replayed answer or a late signal
# cannot move a walk backwards.
#
# A state is a hash with symbol keys, as walk.json holds it once parsed:
# `state` is starting, running (with `after`), paused (with `pause`), or
# ended (with `end`, `ended_at`, and `reached`).
module Nukadoko
  module Engine
    module Walk
      # A transition the walk's table does not have: a bug in the run that
      # applies events, never something a reader of walk.json can cause.
      class TransitionError < StandardError; end

      START_KEYS = %i[number pid target started_at].freeze
      RUN_KEYS = %i[run_id run_dir scenario world].freeze

      module_function

      # One line on what failed the scenario at a pause. The Ruby engine has
      # no AfterStep hooks, but a pause read from a TypeScript walk can
      # name one.
      #: (Hash[Symbol, untyped]) -> String
      def failure_text(pause)
        failure = pause[:failure]
        message = failure[:message].to_s.split("\n").first || ""
        failure[:by] == "step" ? "step #{pause[:pause]} failed: #{message}" : "an AfterStep hook after step #{pause[:pause]} failed: #{message}"
      end

      # The walk's first state, before the run knows its scenario.
      #: (Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def start(start) = { state: "starting", **start.slice(*START_KEYS) }

      # One transition:
      #
      #     starting --begun--> running(after 0) --paused(k > after)--> paused(k)
      #     paused(k) --answered(k)--> running(after k)
      #     any live state --ended--> ended, which absorbs every later event
      #
      # Raises TransitionError for any other pair.
      #: (Hash[Symbol, untyped], Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def advance(state, event)
        return state if state[:state] == "ended"

        starts = state.slice(*START_KEYS)
        if event[:kind] == "ended"
          run = state[:state] == "starting" ? {} : state.slice(*RUN_KEYS)
          reached = case state[:state]
                    when "paused" then state[:pause][:pause]
                    when "running" then state[:after]
                    else 0
                    end
          return { state: "ended", **starts, **run, end: event[:end], ended_at: event[:at], reached: reached }
        end
        case [state[:state], event[:kind]]
        when %w[starting begun] then return { state: "running", **starts, **event[:run].slice(*RUN_KEYS), after: 0 }
        when %w[running paused]
          return { state: "paused", **starts, **state.slice(*RUN_KEYS), pause: event[:pause] } if event[:pause][:pause] > state[:after]
        when %w[paused answered]
          return { state: "running", **starts, **state.slice(*RUN_KEYS), after: state[:pause][:pause] } if event[:pause] == state[:pause][:pause]
        end
        raise TransitionError, "a walk #{state[:state]} cannot take #{event[:kind]}"
      end

      # The one spelling of an answer, for the do lines and the refusals.
      #: (Integer, Integer, String) -> String
      def answer_command(walk, pause, answer) = "nuka step #{answer} #{pause} --walk #{walk}"

      # The one spelling of a wait for one walk.
      #: (Integer) -> String
      def wait_command(walk) = "nuka step wait --walk #{walk}"

      # The command a walk that ended has to be started with again.
      #: (String) -> String
      def restart_command(target) = "nuka run #{target} --step"

      # walk.json as `nuka step` reads it. A walk whose process is gone
      # without recording its end is `gone`: killed, or crashed. `none`: no
      # walk was ever recorded in the project.
      #: (Hash[Symbol, untyped]?, ^(Integer) -> bool) -> Hash[Symbol, untyped]
      def see(stored, alive)
        return { state: "none" } if stored.nil?
        return { state: "gone", last: stored } if stored[:state] != "ended" && !alive.(stored[:pid])

        stored
      end

      #: (Hash[Symbol, untyped]) -> Integer
      def number_of(seen) = seen[:state] == "gone" ? seen[:last][:number] : seen[:number]

      # The walk one `nuka step` call is about, fixed when the call starts.
      # A call is { kind: "wait", walk: Integer? } or { kind: "answer",
      # walk:, pause:, answer: }. A wait that names no walk is about the
      # newest walk until some `nuka step` call has reported how that walk
      # ended, and about the next walk after that, which a `nuka run
      # --step` started just before the wait may not have recorded yet. So
      # a walk that ended before anyone looked is still reported, and an
      # end is not reported in place of the walk that follows it.
      #: (Hash[Symbol, untyped], Hash[Symbol, untyped], ^(Integer) -> bool) -> Integer
      def call_target(call, at_start, end_reported)
        return call[:walk] if call[:kind] == "answer" || call[:walk]
        return 1 if at_start[:state] == "none"

        number = number_of(at_start)
        over = %w[ended gone].include?(at_start[:state])
        over && end_reported.(number) ? number + 1 : number
      end

      # How a walk stands, after its number: "ended: interrupted by SIGTERM,
      # exit 143", "is at pause 2".
      #: (Hash[Symbol, untyped]) -> String
      def standing(seen)
        case seen[:state]
        when "gone" then "is gone: its nuka run --step process (pid #{seen[:last][:pid]}) ended without recording how"
        when "paused" then "is at pause #{seen[:pause][:pause]}"
        when "running" then seen[:after].zero? ? "is running its first step" : "is running the step after pause #{seen[:after]}"
        when "starting" then "is starting"
        else "ended#{how_ended(seen[:end])}"
        end
      end

      # What follows "ended" in a walk's standing.
      #: (Hash[Symbol, untyped]) -> String
      def how_ended(finish)
        case finish[:how]
        when "interrupted" then ": interrupted by #{finish[:signal]}, exit #{finish[:exit_code]}"
        when "not-run" then " before its scenario ran, exit #{finish[:exit_code]}"
        when "error" then " on an unexpected error, exit #{finish[:exit_code]}"
        else
          stopped = finish[:stopped]
          return ": the run finished, exit #{finish[:exit_code]}" unless stopped

          ": stopped after step #{stopped[:after_step]}#{stopped[:line].nil? ? "" : " (line #{stopped[:line]})"}, exit #{finish[:exit_code]}"
        end
      end

      # The message of a wait that found no walk to report before its time
      # ran out: which walk it waited for, and the last walk there is and
      # how it stands, so the caller is not told that nothing ran.
      #: (Hash[Symbol, untyped], Integer, Hash[Symbol, untyped]) -> String
      def nothing_started_message(call, seconds, seen)
        waited = call[:walk] ? "walk #{call[:walk]} did not start within #{seconds}s" : "no new walk started within #{seconds}s"
        return "#{waited}, and this project has recorded no walk" if seen[:state] == "none"

        "#{waited}; the last walk, walk #{number_of(seen)}, #{standing(seen)}"
      end

      #: (Hash[Symbol, untyped]) -> String
      def where_text(seen)
        case seen[:state]
        when "paused" then "the walk is at pause #{seen[:pause][:pause]}"
        when "running" then seen[:after].zero? ? "the walk is running its first step" : "the walk is running the step after pause #{seen[:after]}"
        else "the walk has not reached its first pause"
        end
      end

      # Where the walk walk.json holds stands, for a refusal that names it.
      #: (Hash[Symbol, untyped]) -> String
      def current_text(seen)
        case seen[:state]
        when "gone" then "walk #{seen[:last][:number]}, which is gone"
        when "ended" then "walk #{seen[:number]}, which has ended"
        when "paused" then "walk #{seen[:number]}, at pause #{seen[:pause][:pause]}"
        when "running" then "walk #{seen[:number]}, running"
        else "walk #{seen[:number]}, starting"
        end
      end

      # A call that names a walk walk.json no longer holds, or does not hold
      # yet. The do is a wait for the walk there is, which answers nothing.
      #: (Hash[Symbol, untyped], Integer, Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def not_current(call, target, seen)
        what = call[:kind] == "answer" ? "this answer" : "this wait"
        { kind: "refuse", code: "walk-not-current", message: "#{what} is for walk #{target}, and the walk in this project is #{current_text(seen)}",
          do: wait_command(number_of(seen)) }
      end

      # What one `nuka step` call does next, from walk.json as it stands now
      # (`seen`), the walk the call is about (`target`), and the answers
      # that walk's run directory holds, by pause. Pure, so that repeating a
      # call is a property test: an answer already given the same way
      # reports where the walk went from it, and writes nothing again.
      #: (Hash[Symbol, untyped], Integer, Hash[Symbol, untyped], Hash[Integer, String]) -> Hash[Symbol, untyped]
      def decide(call, target, seen, answers)
        if call[:kind] == "wait"
          return { kind: "wait" } if seen[:state] == "none" || number_of(seen) < target
          # A wait that names its walk is about that walk alone.
          return not_current(call, target, seen) if call[:walk] && number_of(seen) > target
          return { kind: "wait" } if %w[starting running].include?(seen[:state])

          return { kind: "report", seen: seen }
        end
        if seen[:state] == "none"
          return { kind: "refuse", code: "walk-not-found", message: "no walk to answer: nuka run --step has not started one in this project" }
        end
        return not_current(call, target, seen) if number_of(seen) != target
        return { kind: "report", seen: seen } if seen[:state] == "gone"

        given = answers[call[:pause]]
        if given && given != call[:answer]
          ended = seen[:state] == "ended" ? ", and walk #{target} #{standing(seen)}" : ""
          return { kind: "refuse", code: "pause-answered", message: "pause #{call[:pause]} was already answered #{given}#{ended}, so this #{call[:answer]} changes nothing",
                   do: wait_command(target) }
        end
        if seen[:state] == "ended"
          # A pause the walk never reached is no answer to it, and a report
          # would read as one.
          if call[:pause] > seen[:reached]
            finish = seen[:end]
            when_ = if finish[:how] == "not-run" then ""
                    elsif seen[:reached].zero? then " before its first pause"
                    else " after pause #{seen[:reached]}"
                    end
            return { kind: "refuse", code: "pause-not-current", message: "pause #{call[:pause]} is not a pause of walk #{target}, which ended#{when_}#{how_ended(finish)}",
                     do: wait_command(target) }
          end
          # Nothing is left to answer, and how the walk ended is what the
          # caller needs.
          return { kind: "report", seen: seen }
        end
        if given.nil?
          return { kind: "write-answer", run_dir: seen[:run_dir] } if seen[:state] == "paused" && seen[:pause][:pause] == call[:pause]

          return { kind: "refuse", code: "pause-not-current", message: "pause #{call[:pause]} is not the pause the walk waits at: #{where_text(seen)}",
                   do: wait_command(target) }
        end
        # Given this way already: a repeat, or this call's own write. Wait
        # until the run has read it and moved on.
        return { kind: "report", seen: seen } if seen[:state] == "paused" && seen[:pause][:pause] > call[:pause]

        { kind: "wait" }
      end

      #: (Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def run_fields(state)
        return {} if state[:state] == "starting"

        state.slice(*RUN_KEYS)
      end

      # What `nuka step` prints beside the envelope's head: its exit code,
      # its findings, and its fields. 0 for a walk paused, starting,
      # running, or ended green; 1 for one paused where its scenario
      # failed, ended red, interrupted, or gone. A walk starting or running
      # is one the call's wait ran out on: the call itself is then the
      # `do`, since repeating it is safe.
      #: (Hash[Symbol, untyped], Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def report(seen, call)
        case seen[:state]
        when "gone"
          last = seen[:last]
          finding = { severity: "failed", code: "walk-gone",
                      message: "the nuka run --step process (pid #{last[:pid]}) ended without recording how: it was killed or it crashed, so its world and browser may still run",
                      do: restart_command(last[:target]) }
          { exit_code: 1, findings: [finding], fields: { walk: "gone", last: last } }
        when "ended"
          findings = seen[:end][:how] == "interrupted" ? [] : seen[:end][:findings]
          { exit_code: seen[:end][:exit_code].zero? ? 0 : 1, findings: findings, fields: { walk: "ended", **run_fields(seen), end: seen[:end] } }
        when "paused"
          pause = seen[:pause]
          # A pause after a failure answers no differently, but what it
          # shows is a red scenario: a caller that reads only the exit code
          # and the findings must not read it as passing.
          findings = if pause[:failure]
                       [{ severity: "failed", code: "walk-failed", message: failure_text(pause), do: answer_command(seen[:number], pause[:pause], "next") }]
                     else []
                     end
          answers = { next: answer_command(seen[:number], pause[:pause], "next"),
                      **(pause[:remaining].positive? ? { stop: answer_command(seen[:number], pause[:pause], "stop") } : {}) }
          { exit_code: findings.empty? ? 0 : 1, findings: findings, fields: { walk: "paused", **run_fields(seen), pause: pause, do: answers } }
        else
          again = call[:kind] == "answer" ? answer_command(call[:walk], call[:pause], call[:answer]) : wait_command(seen[:number])
          return { exit_code: 0, findings: [], fields: { walk: "starting", do: again } } if seen[:state] == "starting"

          { exit_code: 0, findings: [], fields: { walk: "running", **run_fields(seen), after: seen[:after], do: again } }
        end
      end

      # The lines `nuka run --step` writes on stderr at a pause of walk
      # `walk`, outside `--json`: the step, what failed when the scenario
      # failed there, and the answers.
      #: (Integer, Hash[Symbol, untyped]) -> String
      def pause_lines(walk, pause)
        following = answer_command(walk, pause[:pause], "next")
        either = pause[:remaining].positive? ? "   (or: #{answer_command(walk, pause[:pause], "stop")})" : ""
        failed = pause[:failure] ? "  failure: #{failure_text(pause)}\n" : ""
        "paused after step #{pause[:pause]}/#{pause[:of]} (#{pause[:status]}): #{pause[:text]}\n#{failed}  do: #{following}#{either}\n"
      end
    end
  end
end
