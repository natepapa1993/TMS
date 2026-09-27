"use client";

import { useActionState } from "react";
import { forgotAction, type ResetState } from "../actions";

export function ForgotForm() {
  const [state, action, pending] = useActionState<ResetState, FormData>(forgotAction, {});
  if (state.done === "sent")
    return (
      <div className="card p-5" role="status">
        <div className="font-bold">Check your email</div>
        <p className="text-muted text-[13.5px] mt-1">If {state.fields?.email} has an account, a reset link is on its way. It works for an hour and once.</p>
      </div>
    );
  if (state.done === "no_sender")
    return (
      <div className="card p-5" role="status">
        <div className="font-bold">Ask your company owner</div>
        <p className="text-muted text-[13.5px] mt-1">This company has no email sender connected yet, so no link can go out. The owner can set a new password for you on your user record (Settings → Users).</p>
      </div>
    );
  return (
    <form action={action} className="space-y-4">
      <div>
        <label className="label" htmlFor="email">
          Email
        </label>
        <input id="email" name="email" type="email" className="input" autoComplete="email" defaultValue={state.fields?.email} autoFocus required />
      </div>
      {state.error && (
        <div className="error" role="alert">
          {state.error}
        </div>
      )}
      <button className="btn btn-primary btn-lg w-full justify-center" disabled={pending}>
        {pending ? "Sending…" : "Send the link"}
      </button>
    </form>
  );
}
