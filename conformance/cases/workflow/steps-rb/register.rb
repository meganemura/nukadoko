class Register < Nukadoko::Step
  description "Submit a registration; returns the outcome, never throws on refusal"
  pattern "a registration for {email:string} with password {password:string} is submitted"
  args do
    string :email, "The email registered"
    string :password, "The password chosen"
  end
  returns do
    enum :outcome, %w[accepted refused], "Whether the registration was accepted or refused"
    string :token, "The confirmation token issued, when accepted", null: true
    string :reason, "Why it was refused, when refused", null: true
  end

  def run(store:, args:)
    r = store.register(args.email, args.password)
    r[:ok] ? { outcome: "accepted", token: r[:token], reason: nil } : { outcome: "refused", token: nil, reason: r[:reason] }
  end
end
