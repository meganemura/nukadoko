class PrintTheToken < Nukadoko::Step
  description "Print API_TOKEN from the env fixture, as project code that logs a value does"
  pattern "I print the token"
  # Prints only.
  mutates false

  def run(env:)
    puts "token is #{env.fetch("API_TOKEN")}"
    {}
  end
end
