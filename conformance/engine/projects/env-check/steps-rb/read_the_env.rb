class ReadTheEnv < Nukadoko::Step
  description "Return two values the env files gave the env fixture"
  pattern "I read the env"
  returns do
    string :token, "API_TOKEN, four characters or longer"
    string :short, "SHORT, too short to redact"
  end
  # Reads the env fixture only.
  mutates false

  def run(env:)
    { token: env.fetch("API_TOKEN", ""), short: env.fetch("SHORT", "") }
  end
end
