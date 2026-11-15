class RunGreet < Nukadoko::Step
  pattern "I ask for the greeting"
  description "Runs the greeting program"
  returns do
    string :stdout
    number :exitCode, null: true
    string :stderr
  end
  mutates false

  def run(args:) = Nukadoko.run_command("node", [File.expand_path("lib/greet.mjs")])
end
