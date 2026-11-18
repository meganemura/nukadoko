# frozen_string_literal: true

require "nukadoko"
require_relative "../lib/nukadoko/cli"
require "stringio"
require "tmpdir"

# `nuka <command> --help` prints the command's usage and the flags it reads,
# for every command `nuka --help` lists, and exits 0. A refusal of an unknown
# flag points there, so the help has to exist for each command.
class CommandHelpTest < Minitest::Test
  def help(*argv)
    out = StringIO.new
    code = Dir.mktmpdir { |dir| Nukadoko::CLI.new(argv, project: dir, out: out).call }
    [code, out.string]
  end

  def test_every_listed_command_has_a_help_that_names_its_flags
    _, top = help("--help")
    commands = top.scan(/^  nuka ([a-z]+)/).flatten
    assert_equal commands.sort, Nukadoko::CommandHelp::COMMANDS.keys.sort
    commands.each do |command|
      code, text = help(command, "--help")
      assert_equal 0, code, command
      assert text.start_with?("nuka #{command}"), command
      Nukadoko::CommandHelp::COMMANDS.fetch(command)[:flags].each { |flag, _| assert_includes text, "  #{flag}", command }
    end
  end
end
