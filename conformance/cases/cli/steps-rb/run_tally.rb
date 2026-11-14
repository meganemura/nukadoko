class RunTally < Nukadoko::Step
  description "Run tally with these arguments in the directory an earlier step prepared"
  pattern "I run tally with {argv:string}"
  args do
    string :argv, "Arguments after `tally`, separated by spaces"
    field :dir, ACsvFileWith.returns[:dir]
  end
  from dir: [[ACsvFileWith, :dir], [AnEmptyDirectory, :dir]]
  returns do
    number :exitCode, "The process exit code", null: true
    string :stdout, "Everything the process wrote to stdout"
    string :stderr, "Everything the process wrote to stderr"
  end
  # Runs the program under test in a scratch directory a Given step made.
  mutates false

  def run(args:) = Nukadoko.run_command("node", [File.expand_path("src/cli.ts"), *args.argv.split], cwd: args.dir)
end
