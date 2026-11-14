class Unterminated < Nukadoko::Step
  description "A pattern whose capture never closes"
  pattern "I start {n:int"

  def run(args:) = {}
end
