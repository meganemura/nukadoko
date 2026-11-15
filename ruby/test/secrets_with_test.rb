# frozen_string_literal: true

require "nukadoko"

# A tree's pass redacts with its own secrets and with head's, and a name
# the two sets hold with different values keeps both values redacted.
class SecretsWithTest < Minitest::Test
  S = Nukadoko::Engine::Secrets

  def test_both_values_of_one_name_are_redacted
    joined = S.new("TOKEN" => "tree-value").with(S.new("TOKEN" => "head-value", "KEY" => "head-key"))
    assert_equal "{{secret.TOKEN}} {{secret.TOKEN}} {{secret.KEY}}", joined.redact_string("tree-value head-value head-key")
    assert_equal %w[tree-value head-value head-key], joined.shown_values
  end
end
