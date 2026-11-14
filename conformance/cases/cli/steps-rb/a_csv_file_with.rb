class ACsvFileWith < Nukadoko::Step
  description "Write the docstring to a named file in a fresh scratch directory"
  pattern "a file {name:string} with these lines"
  args do
    string :name, "The file name, relative to the scratch directory"
    string :lines, "The file's contents, verbatim"
  end
  returns do
    string :dir, "The scratch directory the file was written in"
    number :bytes, "Size of the file written, in bytes"
  end
  # Writes only inside the scenario's own scratch directory, which is removed after it.
  mutates false

  def run(scratch:, args:)
    dir = scratch.dir
    body = args.lines.end_with?("\n") ? args.lines : "#{args.lines}\n"
    File.write(File.join(dir, args.name), body)
    { dir: dir, bytes: body.bytesize }
  end
end
