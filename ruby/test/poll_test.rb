# frozen_string_literal: true

require "nukadoko"

class PollTest < Minitest::Test
  CLAIMS = [{ actual: "status", compare: "equal", expected: { literal: "done" } }].freeze
  SETTLED = [{ actual: "status", compare: "not-equal", expected: { literal: "running" } }].freeze

  def poll(readings, settled: [], timeout_ms: 2000)
    record = {}
    queue = readings.dup
    value = Nukadoko::Engine::Poll.new({ timeout_ms: timeout_ms, settled: settled }, CLAIMS, {}).call(record) { { status: queue.size > 1 ? queue.shift : queue.first } }
    [value, record]
  end

  def test_one_holding_reading_is_not_enough
    value, record = poll(%w[running done done])
    assert_equal({ status: "done" }, value)
    assert_equal({ readings: 3, stop: "held" }, record[:poll])
  end

  def test_two_settled_readings_stop_a_broken_claim
    _, record = poll(%w[running failed failed failed], settled: SETTLED)
    assert_equal({ readings: 3, stop: "settled" }, record[:poll])
  end

  def test_a_poll_that_never_holds_stops_at_its_timeout
    _, record = poll(%w[running], timeout_ms: 300)
    assert_equal "timeout", record[:poll][:stop]
    # 100 ms apart within 300 ms: the last reading starts before the timeout.
    assert_includes 2..3, record[:poll][:readings]
  end
end

class PollRecordTest < Minitest::Test
  CLAIMS = PollTest::CLAIMS

  def run_poll(timeout_ms: 1000, &read)
    record = {}
    value = Nukadoko::Engine::Poll.new({ timeout_ms: timeout_ms }, CLAIMS, {}).call(record, &read)
    [value, record]
  end

  def test_a_first_reading_that_holds_is_confirmed_by_a_second
    _, record = run_poll { { status: "done" } }
    assert_equal({ readings: 2, stop: "held" }, record[:poll])
    assert_equal [1, 2], record[:readings].map { _1[:attempt] }
    assert_equal [["done"], ["done"]], record[:readings].map { _1[:actuals] }
  end

  def test_a_reading_that_raised_is_kept_and_the_poll_reads_again
    calls = 0
    value, record = run_poll { (calls += 1) == 1 ? raise("not yet") : { status: "done" } }
    assert_equal({ status: "done" }, value)
    assert_equal "RuntimeError: not yet", record[:readings].first[:error]
    refute record[:readings].first.key?(:raised)
  end

  def test_a_last_reading_that_raised_fails_the_step_with_its_error
    record = {}
    poll = Nukadoko::Engine::Poll.new({ timeout_ms: 250 }, CLAIMS, {})
    error = assert_raises(RuntimeError) { poll.call(record) { raise "gone" } }
    assert_equal "gone", error.message
    assert_equal "timeout", record[:poll][:stop]
    assert(record[:readings].all? { _1[:error] == "RuntimeError: gone" })
  end
end
