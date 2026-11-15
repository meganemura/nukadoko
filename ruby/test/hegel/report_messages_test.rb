# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of the timestamps a messages stream carries: a millisecond
# count splits into seconds and nanos that add back up to it, with nanos
# always under one second, and an ISO time reads back as the same count.
class ReportMessagesTest < Minitest::Test
  include Hegel::Syntax::Methods

  M = Nukadoko::Engine::ReportMessages

  def check(&) = Hegel.test(test_cases: 200, verbosity: :quiet, &)

  def test_a_stamp_adds_back_up_to_its_milliseconds
    check do |tc|
      ms = tc.draw(integers(min_value: 0, max_value: 4_102_444_800_000))
      stamp = M.stamp(ms)
      assert_equal ms, (stamp[:seconds] * 1000) + (stamp[:nanos] / 1_000_000)
      assert_operator stamp[:nanos], :<, 1_000_000_000
      assert_equal 0, stamp[:nanos] % 1_000_000
    end
  end

  def test_an_iso_time_reads_back_as_its_milliseconds
    check do |tc|
      ms = tc.draw(integers(min_value: 0, max_value: 4_102_444_800_000))
      iso = Time.at(Rational(ms, 1000)).utc.iso8601(3)
      assert_equal ms, M.ms_of(iso)
    end
  end
end
