class TheFileHolds < Nukadoko::Step
  description "A file the program's build or prepare wrote holds a line"
  pattern "the file {name:string} holds {text:string}"
  args do
    string :name, "The file, relative to the project"
    string :text, "The file's one line"
  end
  claims [{ actual: "content", compare: "equal", expected: "text" }]

  def observe(args:) = { content: File.read(args.name).strip }
end
