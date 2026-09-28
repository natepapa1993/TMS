"use client";

import { useActionState } from "react";
import { acceptInviteAction, type InviteState } from "./actions";

export function InviteForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(acceptInviteAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <div>
        <label className="label" htmlFor="password">
          Choose a password
        </label>
        <input id="password" name="password" type="password" className="input" autoComplete="new-password" minLength={10} autoFocus required />
      </div>
      <div>
        <label className="label" htmlFor="again">
          Once more
        </label>
        <input id="again" name="again" type="password" className="input" autoComplete="new-password" minLength={10} required />
      </div>
      {state.error && (
        <div className="error" role="alert">
          {state.error}
        </div>
      )}
      <button className="btn btn-primary btn-lg w-full justify-center" disabled={pending}>
        {pending ? "Saving…" : "Set password and sign in"}
      </button>
    </form>
  );
}
