"use client";

import { useActionState } from "react";
import { loginAction, type AuthState } from "../actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<AuthState, FormData>(loginAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <div>
        <label className="label" htmlFor="email">
          Email
        </label>
        <input id="email" name="email" type="email" className="input" autoComplete="email" defaultValue={state.fields?.email} autoFocus required />
      </div>
      <div>
        <label className="label" htmlFor="password">
          Password
        </label>
        <input id="password" name="password" type="password" className="input" autoComplete="current-password" required />
      </div>
      {state.error && (
        <div className="error" role="alert">
          {state.error}
        </div>
      )}
      <button className="btn btn-primary btn-lg w-full justify-center" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
