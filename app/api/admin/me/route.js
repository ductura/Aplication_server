import { createAdminMeHandler } from "../../../../lib/auth/admin-me.js";
import { methodNotAllowed } from "../../../../lib/http/methods.js";

export { OPTIONS } from "../../../../lib/http/methods.js";

// No authentication exists yet, so the deployed route never has an identity and
// always answers 401. Tests inject identities through createAdminMeHandler;
// there is no fake provider or environment switch that could open it.
export const GET = createAdminMeHandler(() => null);

export { methodNotAllowed as POST, methodNotAllowed as PUT, methodNotAllowed as PATCH };
export { methodNotAllowed as DELETE };
