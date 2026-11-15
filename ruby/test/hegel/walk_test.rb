# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of a walk as data: whatever events arrive, a walk never moves
# back to an earlier pause and ends once; and repeating a `nuka step`
# answer writes it at most once, whatever the walk did between the calls.
class WalkTest < Minitest::Test
  include Hegel::Syntax::Methods

  W = Nukadoko::Engine::Walk

  def check(&) = Hegel.test(test_cases: 200, verbosity: :quiet, &)

  def started = W.start({ number: 1, pid: 10, target: "features/a.feature:3", started_at: "2026-11-15T00:00:00.000Z" })

  def run_facts = { run_id: "run-1", run_dir: ".nukadoko/runs/run-1", scenario: { feature: "features/a.feature", line: 3, name: "a", environment: "default" }, world: nil }

  def pause(number, remaining) = { pause: number, of: number + remaining, line: number + 3, text: "step #{number}", step: "s", status: "passed",
                                   record: "steps/s#{number}", remaining: remaining, paused_at: "t", views: [] }

  # Any events, each applied only when the table has the transition.
  def drawn_events(tc)
    tc.draw(arrays(integers(min_value: 0, max_value: 3), max_size: 12)).map do |kind|
      case kind
      when 0 then { kind: "begun", run: run_facts }
      when 1 then { kind: "paused", pause: pause(tc.draw(integers(min_value: 1, max_value: 6)), tc.draw(integers(min_value: 0, max_value: 3))) }
      when 2 then { kind: "answered", pause: tc.draw(integers(min_value: 1, max_value: 6)), answer: tc.draw(sampled_from(%w[next stop])) }
      else { kind: "ended", end: { how: "finished", exit_code: 0, findings: [] }, at: "t" }
      end
    end
  end

  def reached(state) = { "paused" => -> { state[:pause][:pause] }, "running" => -> { state[:after] }, "ended" => -> { state[:reached] } }.fetch(state[:state], -> { 0 }).()

  def test_a_walk_never_moves_back_and_ends_once
    check do |tc|
      state = started
      drawn_events(tc).each do |event|
        before = state
        state = begin
          W.advance(state, event)
        rescue W::TransitionError
          state
        end
        assert_operator reached(state), :>=, reached(before)
        assert_equal before, state if before[:state] == "ended"
      end
    end
  end

  def test_repeating_an_answer_writes_it_at_most_once
    check do |tc|
      at = tc.draw(integers(min_value: 1, max_value: 5))
      remaining = tc.draw(integers(min_value: 0, max_value: 3))
      answer = tc.draw(sampled_from(%w[next stop]))
      call = { kind: "answer", walk: 1, pause: at, answer: answer }
      state = W.advance(W.advance(started, { kind: "begun", run: run_facts }), { kind: "paused", pause: pause(at, remaining) })
      answers = {}
      writes = 0
      # The run may read the answer and move on, pause again, or end, in
      # any order between two calls.
      tc.draw(arrays(integers(min_value: 0, max_value: 3), min_size: 1, max_size: 8)).each do |move|
        decision = W.decide(call, 1, state, answers)
        if decision[:kind] == "write-answer"
          writes += 1
          answers[at] = answer
        end
        state = case move
                when 1 then answers[at] && state[:state] == "paused" && state[:pause][:pause] == at ? W.advance(state, { kind: "answered", pause: at, answer: answer }) : state
                when 2 then state[:state] == "running" ? W.advance(state, { kind: "paused", pause: pause(state[:after] + 1, 0) }) : state
                when 3 then W.advance(state, { kind: "ended", end: { how: "finished", exit_code: 0, findings: [] }, at: "t" })
                else state
                end
      end
      assert_operator writes, :<=, 1
    end
  end

  def test_an_answer_to_another_walk_is_refused_as_not_current
    check do |tc|
      walk = tc.draw(integers(min_value: 2, max_value: 50))
      state = W.advance(W.advance(started, { kind: "begun", run: run_facts }), { kind: "paused", pause: pause(1, 1) })
      decision = W.decide({ kind: "answer", walk: walk, pause: 1, answer: "next" }, walk, state, {})
      assert_equal "walk-not-current", decision[:code]
      assert_equal "nuka step wait --walk 1", decision[:do]
    end
  end
end
