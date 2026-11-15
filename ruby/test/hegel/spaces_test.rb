# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of the views that trim a text: they take the spaces
# JavaScript's trim takes at either end and nothing else, so a text the
# TypeScript engine trims to one value the Ruby engine trims to the same,
# and a comma-list has one item more than the text has commas, as
# JavaScript's split keeps an empty item.
class SpacesTest < Minitest::Test
  include Hegel::Syntax::Methods

  C = Nukadoko::Engine::Claims
  S = Nukadoko::Engine::Spaces

  def check(&) = Hegel.test(test_cases: 300, verbosity: :quiet, &)

  # Every space JavaScript's trim takes, one of each kind.
  TRIMMED = [" ", "\t", "\n", "\r", "\v", "\f", " ", " ", " ", " ", " ", " ", " ", " ", "　", "﻿"].freeze
  # Characters a reader may take for a space that JavaScript's trim keeps.
  KEPT = ["\0", "\u0085", "​", "᠎", "⁠"].freeze
  PIECES = ["a", "b c", ",", "x", *TRIMMED, *KEPT].freeze

  def text(tc, from) = Array.new(tc.draw(integers(min_value: 0, max_value: 6))) { tc.draw(sampled_from(from)) }.join

  def test_trimmed_spaces_around_a_text_change_no_view
    check do |tc|
      core = text(tc, PIECES)
      padded = "#{text(tc, TRIMMED)}#{core}#{text(tc, TRIMMED)}"
      assert_equal C.view("comma-list", core), C.view("comma-list", padded), padded.inspect
      assert_equal C.view("text", core), C.view("text", "#{core}#{text(tc, TRIMMED)}"), core.inspect
    end
  end

  def test_a_kept_character_stays_at_either_end
    check do |tc|
      kept = tc.draw(sampled_from(KEPT))
      core = text(tc, PIECES)
      assert_equal "#{kept}#{core}#{kept}", S.trim("#{kept}#{core}#{kept}")
      refute S.blank?(kept)
    end
  end

  def test_a_comma_list_has_one_item_more_than_its_commas
    check do |tc|
      value = text(tc, PIECES)
      list = C.view("comma-list", value)
      expected = S.blank?(value) ? 0 : S.trim(value).count(",") + 1
      assert_equal expected, list.size, value.inspect
    end
  end
end
