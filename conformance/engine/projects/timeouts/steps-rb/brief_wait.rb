class BriefWait < Nukadoko::Step
  description "Wait, under a timeout of its own"
  pattern "it waits briefly for {ms:int} ms"
  args { number :ms, "How long to wait" }
  timeout 100
  mutates false

  def run(args:)
    sleep args.ms / 1000.0
    {}
  end
end
