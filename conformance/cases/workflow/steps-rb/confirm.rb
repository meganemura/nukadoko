class Confirm < Nukadoko::Step
  description "Open the confirmation link the registration issued"
  pattern "the confirmation link is opened"
  args { field :token, Register.returns[:token] }
  from token: [Register, :token]
  returns { string :email, "The email the token confirmed", null: true }

  def run(store:, args:)
    raise "the registration issued no token, so there is no link to open" unless args.token

    { email: store.confirm(args.token)[:email] }
  end
end
