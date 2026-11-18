class TheReaderReads < Nukadoko::Step
  description "Whoever is signed in reads"
  pattern "the reader reads"
  args { string :person, "Who reads", optional: true }
  requires ["signed-in", :person]
  mutates false

  def run = nil
end
