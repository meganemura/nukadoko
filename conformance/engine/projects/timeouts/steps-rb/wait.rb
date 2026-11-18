class Wait < Nukadoko::Step
  description "Wait, under the project's stepTimeout"
  pattern "it waits {ms:int} ms"
  args { number :ms, "How long to wait" }
  mutates false

  def run(args:)
    sleep args.ms / 1000.0
    {}
  end
end
