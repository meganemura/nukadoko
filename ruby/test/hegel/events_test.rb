# frozen_string_literal: true

require "hegel"
require "nukadoko"
require "tmpdir"

# Properties of execution events as the Ruby engine reads them: a line
# that holds a kind's required fields is an event whatever its trace's
# case, the same object written with a key twice is unreadable, a tally's
# kinds add up to its lines whatever order the lines come in, and the
# lines read from a file do not depend on where the writer's writes split
# them.
class EventsPropertiesTest < Minitest::Test
  include Hegel::Syntax::Methods

  E = Nukadoko::Engine::Events

  def check(&) = Hegel.test(test_cases: 200, verbosity: :quiet, &)

  TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
  SPANS = %w[00f067aa0ba902b7 a3ce929d0e0e4736 b7ad6b7169203331].freeze

  def draw_event(tc, trace)
    case tc.draw(sampled_from(%w[request db tx job error]))
    when "request"
      { "trace" => trace, "kind" => "request", "method" => tc.draw(sampled_from(%w[GET POST])), "route" => tc.draw(sampled_from(["/items", nil])),
        "status" => tc.draw(integers(min_value: 100, max_value: 599)) }
    when "db"
      { "trace" => trace, "kind" => "db", "table" => tc.draw(sampled_from(%w[items users unknown])), "op" => tc.draw(sampled_from(E::DB_OPS)),
        "committed" => tc.draw(booleans) }
    when "tx" then { "trace" => trace, "kind" => "tx", "id" => "t#{tc.draw(integers(min_value: 1, max_value: 3))}", "phase" => tc.draw(sampled_from(%w[commit rollback])) }
    when "job"
      { "trace" => trace, "kind" => "job", "name" => "Mail", "phase" => tc.draw(sampled_from(%w[enqueue perform])), "job_id" => "j#{tc.draw(integers(min_value: 1, max_value: 2))}" }
    else { "trace" => trace, "kind" => "error", "class" => "Boom", "handled" => tc.draw(booleans) }
    end
  end

  def traceparent(tc) = "00-#{TRACE}-#{tc.draw(sampled_from(SPANS))}-01"

  def test_a_line_with_its_kinds_required_fields_is_an_event_in_either_case
    check do |tc|
      event = draw_event(tc, tc.draw(booleans) ? traceparent(tc).upcase : TRACE)
      line = E.parse_line(JSON.generate(event))
      assert_equal "event", line.state, line.why
      assert_equal TRACE, line.trace&.trace_id
      assert_equal event, line.object
    end
  end

  def test_a_key_written_twice_makes_the_line_unreadable
    check do |tc|
      event = draw_event(tc, TRACE)
      key = tc.draw(sampled_from(event.keys))
      text = JSON.generate(event).sub(/\}\z/, ",#{JSON.generate(key)}:#{JSON.generate(event[key])}}")
      line = E.parse_line(text)
      assert_equal "unreadable", line.state
      assert_equal "holds the key #{JSON.generate(key)} twice in one object", line.why
    end
  end

  def test_a_tallys_kinds_add_up_to_its_lines_in_any_order
    check do |tc|
      lines = Array.new(tc.draw(integers(min_value: 0, max_value: 8))) { E.parse_line(JSON.generate(draw_event(tc, traceparent(tc)))) }
      inputs = { spans: SPANS, spans_not_kept: 0, processes: "none", process_spans: [] }
      forward = E::Tally.new(inputs)
      lines.each { forward.owned(_1) }
      backward = E::Tally.new(inputs)
      lines.reverse_each { backward.owned(_1) }
      reading = forward.reading(truncated: false, replaced: false)
      assert_equal lines.size, reading[:lines]
      assert_equal lines.size, reading[:kinds].values.sum
      # Jobs are named in the order the lines first name them.
      sorted = ->(found) { found.merge(open: found[:open].map { _1.key?(:job_ids) ? _1.merge(job_ids: _1[:job_ids].sort) : _1 }) }
      assert_equal sorted.(reading), sorted.(backward.reading(truncated: false, replaced: false))
      assert_equal reading[:open].empty?, reading[:whole]
    end
  end

  # A compare holds on a range only when it holds for every count in it,
  # and breaks only when it holds for none: checked against each count of
  # a bounded range, and of an unbounded one up to past the expected value.
  def test_a_count_range_is_judged_by_every_count_in_it
    check do |tc|
      low = tc.draw(integers(min_value: 0, max_value: 6))
      high = tc.draw(booleans) ? nil : low + tc.draw(integers(min_value: 0, max_value: 4))
      compare = tc.draw(sampled_from(E::Count::COMPARES))
      expected = tc.draw(integers(min_value: 0, max_value: 12))
      counts = (low..(high || 30)).to_a
      answers = counts.map { E::Count.judge_range({ at_least: _1, at_most: _1 }, compare, expected) }
      want = if answers.all?(:held) then :held
             elsif answers.all?(:broken) then :broken
             else :unknown
             end
      assert_equal want, E::Count.judge_range({ at_least: low, at_most: high }, compare, expected)
    end
  end

  # A count that is one number is compared as the number is.
  def test_a_count_of_one_number_compares_as_the_number
    check do |tc|
      count = tc.draw(integers(min_value: 0, max_value: 9))
      expected = tc.draw(integers(min_value: 0, max_value: 9))
      compare = tc.draw(sampled_from(E::Count::COMPARES))
      holds = { "equal" => count == expected, "not-equal" => count != expected, "greater-than" => count > expected,
                "at-least" => count >= expected, "less-than" => count < expected, "at-most" => count <= expected }.fetch(compare)
      assert_equal holds ? :held : :broken, E::Count.judge_range({ at_least: count, at_most: count }, compare, expected)
    end
  end

  def test_the_lines_read_do_not_depend_on_where_the_writes_split
    check do |tc|
      texts = Array.new(tc.draw(integers(min_value: 1, max_value: 5))) { tc.draw(sampled_from(["a", "é ü", "{\"x\":1}", "", "日本語"])) }
      whole = texts.map { "#{_1}\n" }.join.b
      split = tc.draw(integers(min_value: 0, max_value: whole.bytesize))
      Dir.mktmpdir do |dir|
        path = File.join(dir, "events.jsonl")
        File.binwrite(path, whole.byteslice(0, split))
        seen = []
        offset = E.each_line(path, 0) { |text, _| seen << text }
        File.binwrite(path, whole)
        E.each_line(path, offset) { |text, _| seen << text }
        assert_equal texts, seen
      end
    end
  end
end
