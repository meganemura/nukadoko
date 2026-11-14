class SignIn < Nukadoko::Step
  description "Attempt a sign-in; returns the outcome, never raises on refusal"
  pattern "{email:string} signs in with password {password:string}"
  args do
    string :email, "The email used"
    string :password, "The password used"
  end
  returns do
    enum :outcome, %w[accepted refused], "Whether the sign-in was accepted or refused"
    string :reason, "Why it was refused, when refused", null: true
  end
  mutates false

  def run(store:, args:)
    r = store.sign_in(args.email, args.password)
    r[:ok] ? { outcome: "accepted", reason: nil } : { outcome: "refused", reason: r[:reason] }
  end
end
