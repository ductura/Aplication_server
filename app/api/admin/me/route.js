import { requireAdmin } from "../../../../lib/auth/require-admin.js";

// No authentication exists yet (JWT arrives in DAN-1105), so the deployed route
// always sees no identity and answers 401. Tests inject an identity through
// createAdminMeHandler; there is no fake provider or environment switch.
const noIdentity = () => null;

export function createAdminMeHandler(getIdentity) {
  return async function GET(request) {
    const denied = requireAdmin(await getIdentity(request));
    if (denied) return denied;
    return Response.json({ role: "admin" }, { headers: { "Cache-Control": "no-store" } });
  };
}

export const GET = createAdminMeHandler(noIdentity);
