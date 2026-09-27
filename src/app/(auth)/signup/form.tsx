"use client";

import { useActionState } from "react";
import { signupAction, type AuthState } from "../actions";

export function SignupForm() {
  const [state, action, pending] = useActionState<AuthState, FormData>(signupAction, {});
  const f = state.fields ?? {};
  return (
    <form action={action} className="space-y-4">
      <div>
        <label className="label" htmlFor="tenantName">
          Company name
        </label>
        <input id="tenantName" name="tenantName" className="input" defaultValue={f.tenantName} placeholder="24:7 Expedite" autoFocus required />
      </div>
      <div>
        <label className="label" htmlFor="ownerName">
          Your name
        </label>
        <input id="ownerName" name="ownerName" className="input" defaultValue={f.ownerName} required />
      </div>
      <div>
        <label className="label" htmlFor="email">
          Email
        </label>
        <input id="email" name="email" type="email" className="input" autoComplete="email" defaultValue={f.email} required />
      </div>
      <div>
        <label className="label" htmlFor="password">
          Password
        </label>
        <input id="password" name="password" type="password" className="input" autoComplete="new-password" minLength={10} required />
        <div className="help">At least 10 characters.</div>
      </div>
      {state.error && (
        <div className="error" role="alert">
          {state.error}
        </div>
      )}
      <button className="btn btn-primary btn-lg w-full justify-center" disabled={pending}>
        {pending ? "Creating…" : "Create company"}
      </button>
    </form>
  );
}
