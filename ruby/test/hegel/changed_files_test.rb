# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of the list a files key reads: it holds exactly the paths the
# key selects, sorted and once each, and a step whose processes were not
# all walked whole gives no list at all.
class ChangedFilesPropertiesTest < Minitest::Test
  include Hegel::Syntax::Methods

  C = Nukadoko::Engine::ChangedFiles

  def check(&) = Hegel.test(test_cases: 300, verbosity: :quiet, &)

  PATHS = %w[src/ src/a.rb src/b/c.rb srcs/x.rb readme.md notes/a.txt].freeze
  CHANGES = %w[added changed removed].freeze

  def draw_process(tc)
    files = CHANGES.to_h { [_1.to_sym, Array.new(tc.draw(integers(min_value: 0, max_value: 3))) { tc.draw(sampled_from(PATHS)) }] }
    { cwd: "/work", group: "ended", files: files }
  end

  def draw_entry(tc)
    entry = { of: Class.new }
    entry[:change] = tc.draw(sampled_from([CHANGES.first, %w[added removed], ["changed"]])) if tc.draw(booleans)
    entry[:under] = tc.draw(sampled_from(%w[src src/ notes])) if tc.draw(booleans)
    entry
  end

  def test_the_list_holds_exactly_the_selected_paths_sorted_and_once
    check do |tc|
      processes = Array.new(tc.draw(integers(min_value: 1, max_value: 3))) { draw_process(tc) }
      entry = draw_entry(tc)
      side = C.side(entry, { of: "write@3", record: { step_record_id: "step-1", processes: processes } })
      dir = entry[:under] && C.directory(entry[:under])
      expected = processes.flat_map { |process| C.changes(entry).flat_map { process[:files][_1.to_sym] } }
                          .select { dir.nil? || (_1.start_with?(dir) && _1 != dir) }.uniq.sort
      assert_equal expected, side[:paths], entry.inspect
      assert_equal(processes.size == 1 ? "observed.processes[0].files" : "observed.processes", side.dig(:measured, :channel))
    end
  end

  def test_a_process_not_walked_whole_gives_no_list
    check do |tc|
      processes = Array.new(tc.draw(integers(min_value: 1, max_value: 3))) { draw_process(tc) }
      broken = tc.draw(integers(min_value: 0, max_value: processes.size - 1))
      processes[broken] = case tc.draw(integers(min_value: 0, max_value: 2))
                          when 0 then processes[broken].except(:files)
                          when 1 then processes[broken].merge(files: { unmeasured: "too many entries" })
                          else processes[broken].merge(group: "running")
                          end
      side = C.side(draw_entry(tc), { of: "write@3", record: { step_record_id: "step-1", processes: processes } })
      refute side.key?(:paths)
      assert_includes side[:unjudged], "process #{broken + 1} of write@3"
    end
  end
end
