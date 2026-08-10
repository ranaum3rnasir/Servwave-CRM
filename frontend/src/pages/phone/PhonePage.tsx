import { PhoneShell } from "@/pages/phone/PhoneShell";

/**
 * Task A3 — the `/phone` route's page component (lazy-imported from
 * App.tsx). Route-level auth/permission gating lives in
 * `RequireCommunicationCreate`, not here; this file just mounts the shell.
 */
export default function PhonePage() {
  return <PhoneShell />;
}
