class AnEmptyDirectory < Nukadoko::Step
  description "A fresh, empty scratch directory to run the command in"
  pattern "an empty directory"
  returns { string :dir, "The scratch directory" }
  mutates false

  def run(scratch:, args:) = { dir: scratch.dir }
end
