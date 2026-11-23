# frozen_string_literal: true

require "nukadoko"

# `nuka steps <target>`: which steps the selected lines bind, which steps
# those call through parts, and the lines that bind no single step.
class VocabularyTargetsTest < Minitest::Test
  E = Nukadoko::Engine

  class TargetsPlace < Nukadoko::Step
    description "Place one book"
    args { string :title, "The title" }
    def run = {}
  end

  class TargetsShelve < Nukadoko::Step
    description "Shelve a book through one part"
    pattern "a book titled {title:string} is shelved"
    args { string :title, "The title" }
    parts [TargetsPlace]
    def run = {}
  end

  class TargetsDust < Nukadoko::Step
    description "Dust the shelf"
    pattern "the shelf is dusted"
    def run = {}
  end

  class TargetsDustAgain < Nukadoko::Step
    description "Dust the shelf, a second pattern for the same words"
    pattern "the shelf is {word}"
    def run = {}
  end

  def scenario(line, *steps)
    lines = steps.map { |text, at| E::PickleStep.new(text, at, "action", nil, nil, false) }
    E::Scenario.new("features/shelf.feature", line, line, "a scenario", [], lines, [], nil, nil, false)
  end

  def test_lists_bound_steps_and_their_parts_with_lines
    steps = [TargetsDust, TargetsDustAgain, TargetsPlace, TargetsShelve]
    scenarios = [scenario(3, ['a book titled "Dune" is shelved', 4], ["the shelf is painted", 5]),
                 scenario(7, ['a book titled "Dune" is shelved', 4], ["the shelf is dusted", 8], ["nothing reads this", 9])]
    places, findings = Nukadoko::Vocabulary.of_targets(steps, scenarios)

    assert_equal [[TargetsDustAgain, { lines: ["features/shelf.feature:5"] }],
                  [TargetsPlace, { lines: [], part_of: [TargetsShelve.step_name] }],
                  [TargetsShelve, { lines: ["features/shelf.feature:4"] }]], places
    assert_equal [["ambiguous-step", 8], ["undefined-step", 9]], findings.map { [_1[:code], _1[:line]] }
    assert_equal "nuka scaffold --feature features/shelf.feature", findings.last[:do]
  end
end
