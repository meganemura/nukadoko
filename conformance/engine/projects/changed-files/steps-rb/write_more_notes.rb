require "tmpdir"

class WriteMoreNotes < Nukadoko::Step
  pattern "more notes are written"
  description "Runs the same program again in a new directory"
  returns { number :exitCode, "The exit code", null: true }
  mutates false

  def run = Nukadoko.run_command("node", [File.expand_path("lib/write.mjs")], cwd: Dir.mktmpdir("nukadoko-notes")).slice(:exitCode)
end
