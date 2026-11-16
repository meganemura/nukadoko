# frozen_string_literal: true

require "nukadoko"
require "tmpdir"

# The section, poll, and evidence fixtures, each with the list the engine
# writes into the step record.
class StepFixturesTest < Minitest::Test
  E = Nukadoko::Engine

  def test_sections_keep_each_label_in_call_order
    sections = E::Sections.new
    assert_nil sections.("one")
    sections.(:two)
    assert_equal %w[one two], sections.entries.map { _1[:label] }
    assert(sections.entries.all? { _1[:at].end_with?("Z") })
  end

  def test_poll_returns_the_first_value_and_counts_the_attempts
    polls = E::Polls.new
    tries = 0
    value = polls.(description: "a count", interval: 1) { (tries += 1) >= 3 ? tries : nil }
    assert_equal 3, value
    entry = polls.entries.first
    assert_equal({ description: "a count", attempts: 3, outcome: "resolved" }, entry.slice(:description, :attempts, :outcome))
  end

  def test_poll_times_out_with_the_attempt_in_flight
    polls = E::Polls.new
    error = assert_raises(Nukadoko::PollTimeoutError) { polls.(timeout: 50, interval: 10) { sleep 1 } }
    assert_equal "poll timed out after 50ms", error.message
    assert_equal({ attempts: 1, outcome: "timed_out" }, polls.entries.first.slice(:attempts, :outcome))
  end

  def test_a_block_that_rescues_its_errors_still_ends_at_the_budget
    polls = E::Polls.new
    assert_raises(Nukadoko::PollTimeoutError) do
      polls.(timeout: 50, interval: 10) do
        sleep 1
      rescue StandardError
        :swallowed
      end
    end
  end

  def test_poll_keeps_a_raise_from_the_block
    polls = E::Polls.new
    assert_raises(KeyError) { polls.(interval: 1) { raise KeyError, "gone" } }
    assert_equal "failed", polls.entries.first[:outcome]
  end

  def test_poll_refuses_a_budget_that_cannot_end_and_records_nothing
    polls = E::Polls.new
    [0, -1, Float::NAN, Float::INFINITY, "5"].each do |bad|
      assert_raises(Nukadoko::InvalidPollOptionsError) { polls.(timeout: bad) { 1 } }
    end
    assert_raises(Nukadoko::InvalidPollOptionsError) { polls.(interval: 0) { 1 } }
    assert_empty polls.entries
  end

  def test_evidence_keeps_both_files_of_one_name
    Dir.mktmpdir do |dir|
      evidence = E::Evidence.new(dir)
      evidence.attach("dump.json", "1")
      evidence.attach("DUMP.json", "2")
      path = evidence.path("dump.json")
      File.write(path, "3")
      evidence.path("never.txt")
      attachments, total = evidence.snapshot
      assert_equal %w[dump.json DUMP-2.json dump-3.json], attachments.map { _1[:file] }
      assert_equal %w[1 2 3], attachments.map { File.read(File.join(dir, _1[:file])) }
      assert_nil total
    end
  end

  def test_evidence_refuses_a_name_outside_or_of_the_engine
    Dir.mktmpdir do |dir|
      evidence = E::Evidence.new(dir)
      ["", ".", "..", "a/b", "a\\b"].each { |name| assert_raises(Nukadoko::InvalidEvidenceNameError) { evidence.attach(name, "x") } }
      %w[record.json Trace.zip judged process-1.stdout.txt trace.aki.zip final.ben.png].each do |name|
        assert_raises(Nukadoko::ReservedEvidenceNameError) { evidence.path(name) }
      end
      assert_empty Dir.children(dir)
    end
  end

  def test_evidence_lists_at_most_the_cap_with_the_whole_count
    Dir.mktmpdir do |dir|
      evidence = E::Evidence.new(dir)
      (E::Evidence::MAX_ATTACHMENTS + 2).times { evidence.attach("f#{_1}.txt", "x") }
      attachments, total = evidence.snapshot
      assert_equal E::Evidence::MAX_ATTACHMENTS, attachments.size
      assert_equal E::Evidence::MAX_ATTACHMENTS + 2, total
    end
  end
end
