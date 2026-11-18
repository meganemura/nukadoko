# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of the states walk and of the line a fix suggests: the walk
# reports a requiring line exactly when the state is not held for its
# holder on the one path that reaches it, and the line a fix suggests is
# one the giving step's pattern matches, with the holder it names.
class StatesPropertiesTest < Minitest::Test
  include Hegel::Syntax::Methods

  S = Nukadoko::Engine::States
  E = Nukadoko::Engine::ExampleLine

  def check(&) = Hegel.test(test_cases: 300, verbosity: :quiet, &)

  # A step as the walk reads it, without registering a class.
  FakeStep = Data.define(:step_name, :patterns, :states, :claims, :parts, :args)

  PERSON = Nukadoko::Schema.build { string :person, "Who" }
  SIGN_IN = FakeStep.new("sign-in", ["{person:word} signs in"], S::Declared.new([], [S::Use.new("signed-in", "person")], []), nil, [], PERSON)
  SIGN_OUT = FakeStep.new("sign-out", ["{person:word} signs out"], S::Declared.new([], [], [S::Use.new("signed-in", "person")]), nil, [], PERSON)
  OPEN = FakeStep.new("open", ["{person:word} opens a book"], S::Declared.new([S::Use.new("signed-in", "person")], [], []), nil, [], PERSON)
  WAVE = FakeStep.new("wave", ["{person:word} waves"], S::Declared.new([], [], []), nil, [], PERSON)
  STEPS = [SIGN_IN, SIGN_OUT, OPEN, WAVE].freeze

  def test_a_requiring_line_is_reported_exactly_when_its_holder_does_not_hold_the_state
    check do |tc|
      lines = Array.new(tc.draw(integers(min_value: 1, max_value: 8))) do
        [tc.draw(sampled_from(STEPS)), tc.draw(sampled_from(%w[aki ben]))]
      end
      held = []
      expected = lines.each_index.select do |at|
        step, person = lines[at]
        missing = step == OPEN && !held.include?(person)
        held |= [person] if step == SIGN_IN
        held -= [person] if step == SIGN_OUT
        missing
      end
      walked = S.walk(lines.map { |step, person| S::Line.new(step: step, texts: { "person" => person }) }, S::Index.new(STEPS))
      assert_equal expected, walked.flat_map { [_1.index, *_1.also] }.sort, lines.map { "#{_2} #{_1.step_name}" }.inspect
    end
  end

  def test_a_line_no_step_matches_leaves_every_state_unknown
    check do |tc|
      after = Array.new(tc.draw(integers(min_value: 1, max_value: 4))) { [tc.draw(sampled_from(STEPS)), tc.draw(sampled_from(%w[aki ben]))] }
      lines = [nil, *after.map { |step, person| S::Line.new(step: step, texts: { "person" => person }) }]
      ended = []
      expected = after.each_index.select do |at|
        step, person = after[at]
        ended |= [person] if step == SIGN_OUT
        ended -= [person] if step == SIGN_IN
        step == OPEN && ended.include?(person)
      end.map { _1 + 1 }
      assert_equal expected, S.walk(lines, S::Index.new(STEPS)).flat_map { [_1.index, *_1.also] }.sort
    end
  end

  PARTS = ["opens", "a book", "(s)", "page/sheet", "\\(1\\)"].freeze
  WORDS = %w[aki ben-2 x].freeze
  TEXTS = ["Aki Tanaka", "", "say \"hi\"", "a'b"].freeze

  def test_the_line_a_fix_suggests_is_matched_by_the_pattern_with_the_values_given
    check do |tc|
      count = tc.draw(integers(min_value: 1, max_value: 4))
      filled = {}
      pieces = Array.new(count) do |n|
        case tc.draw(integers(min_value: 0, max_value: 2))
        when 0 then tc.draw(sampled_from(PARTS))
        when 1 then "{w#{n}:word}".tap { filled["w#{n}"] = tc.draw(sampled_from(WORDS)) }
        else "{s#{n}:string}".tap { filled["s#{n}"] = tc.draw(sampled_from(TEXTS)) }
        end
      end
      pattern = pieces.join(" ")
      line = E.of(pattern, filled)
      assert_equal filled, Nukadoko::Engine::Pattern.new(pattern).match(line), "#{pattern} -> #{line}"
    end
  end

  def test_a_word_capture_never_takes_a_value_with_a_space
    check do |tc|
      value = tc.draw(sampled_from(TEXTS + WORDS))
      line = E.of("{who:word} signs in", { "who" => value })
      expected = value.empty? || value.match?(/\s/) ? "<who> signs in" : "#{value} signs in"
      assert_equal expected, line
    end
  end
end
