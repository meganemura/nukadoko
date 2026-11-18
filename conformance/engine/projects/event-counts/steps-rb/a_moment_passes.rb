class AMomentPasses < Nukadoko::Step
  description "Wait long enough for lines the program writes later to arrive"
  pattern "a moment passes"
  returns { number :waited, "The milliseconds waited" }

  def run
    sleep 0.6
    { waited: 600 }
  end
end
