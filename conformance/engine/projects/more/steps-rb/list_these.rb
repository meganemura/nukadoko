class ListThese < Nukadoko::Step
  description "List two things"
  pattern "I list these"
  args do
    string :a, "The first"
    string :b, "The second"
  end
  mutates false

  def run(args:, store:) = { size: store.size }
end
