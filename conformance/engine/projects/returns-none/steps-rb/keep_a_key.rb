class KeepAKey < Nukadoko::Step
  description "Return a key with no returns declared"
  pattern "a key is kept"
  mutates false

  def run = { extra: 1 }
end
