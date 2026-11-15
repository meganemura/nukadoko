class EndOnACall < Nukadoko::Step
  description "Return nothing with no returns declared"
  pattern "nothing is kept"
  mutates false

  # A Ruby method gives back its last value; with no returns it is not kept.
  def run = [1, 2].sum
end
