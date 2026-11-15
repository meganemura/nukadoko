# frozen_string_literal: true

require "nukadoko"
require "stringio"

# `nuka skill path` names a directory that holds both skills, staged into
# the gem or read from the repository root.
class SkillTest < Minitest::Test
  def test_the_path_holds_every_skill_the_gem_ships
    out = StringIO.new
    assert_equal 0, Nukadoko::Skill.print_path(out, StringIO.new)
    dir = out.string.chomp
    assert File.file?(File.join(dir, "nukadoko", "SKILL.md"))
    assert File.file?(File.join(dir, "nukadoko-verification", "SKILL.md"))
  end
end
