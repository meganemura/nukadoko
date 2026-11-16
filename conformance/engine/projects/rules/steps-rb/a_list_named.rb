class AListNamed < Nukadoko::Step
  description "Start a list by its name"
  pattern "a list named {name:string}"
  args do
    string :name, "The list's name"
  end
  returns do
    string :name, "The list's name"
  end
  # Keeps nothing.
  mutates false

  def run(args:) = { name: args.name }
end
