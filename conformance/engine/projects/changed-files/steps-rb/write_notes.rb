require "tmpdir"

class WriteNotes < Nukadoko::Step
  pattern "the notes are written"
  description "Runs a program that writes two notes and a readme in a new directory"
  returns { number :exitCode, "The exit code", null: true }
  mutates false

  def run = Nukadoko.run_command("node", [File.expand_path("lib/write.mjs")], cwd: Dir.mktmpdir("nukadoko-notes")).slice(:exitCode)
end
