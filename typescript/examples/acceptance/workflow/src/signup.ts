// Sign-up: register, confirm by token, then sign in. In-memory, one store per call.
export type Store = ReturnType<typeof createStore>;
export function createStore() {
  const users = new Map<string, { password: string; confirmed: boolean; token: string }>();
  let n = 0;
  return {
    register(email: string, password: string): { ok: true; token: string } | { ok: false; reason: string } {
      if (users.has(email)) return { ok: false, reason: "email already registered" };
      if (password.length < 8) return { ok: false, reason: "password shorter than 8 characters" };
      const token = `tok-${++n}`;
      users.set(email, { password, confirmed: false, token });
      return { ok: true, token };
    },
    confirm(token: string): { ok: boolean; email: string | null } {
      for (const [email, u] of users) if (u.token === token) { u.confirmed = true; return { ok: true, email }; }
      return { ok: false, email: null };
    },
    signIn(email: string, password: string): { ok: true } | { ok: false; reason: string } {
      const u = users.get(email);
      if (!u || u.password !== password) return { ok: false, reason: "unknown email or wrong password" };
      if (!u.confirmed) return { ok: false, reason: "email not confirmed" };
      return { ok: true };
    },
  };
}
