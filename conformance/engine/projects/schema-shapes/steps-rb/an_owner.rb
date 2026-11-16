class AnOwner < Nukadoko::Step
  description "Name the list's owner"
  pattern "an owner {name:string}"
  args do
    string :name, "The owner's name", min: 1
  end
  returns do
    string :name, "The owner's name"
  end
  # Keeps nothing.
  mutates false

  def run(args:) = { name: args.name }
end
