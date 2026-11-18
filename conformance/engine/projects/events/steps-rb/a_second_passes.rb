class ASecondPasses < Nukadoko::Step
  description "Wait one second"
  pattern "a second passes"
  # Waits only.
  mutates false

  def run
    sleep 1
    {}
  end
end
