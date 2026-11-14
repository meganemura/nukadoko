class Painted < Nukadoko::Step
  description "A pattern that names a type no one registered"
  pattern "I paint it {c:color}"
  args { string :c, "A color" }

  def run(args:) = {}
end
