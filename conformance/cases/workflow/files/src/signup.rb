# Sign-up: register, confirm by token, then sign in. In memory, one store per call.
module Signup
  User = Struct.new(:password, :confirmed, :token)

  class Store
    def initialize
      @users = {}
      @n = 0
    end

    def register(email, password)
      return { ok: false, reason: "email already registered" } if @users.key?(email)
      return { ok: false, reason: "password shorter than 8 characters" } if password.length < 8

      token = "tok-#{@n += 1}"
      @users[email] = User.new(password, false, token)
      { ok: true, token: token }
    end

    def confirm(token)
      email, user = @users.find { |_, u| u.token == token }
      return { ok: false, email: nil } unless user

      user.confirmed = true
      { ok: true, email: email }
    end

    def sign_in(email, password)
      user = @users[email]
      return { ok: false, reason: "unknown email or wrong password" } if !user || user.password != password
      return { ok: false, reason: "email not confirmed" } unless user.confirmed

      { ok: true }
    end
  end
end
