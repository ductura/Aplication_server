// POST /api/admin/odjava: clears the ductura_admin cookie.
import { odjava, ostaleMetode } from "../../../../admin/prijava.js";

export const POST = odjava;
const { OPTIONS, nedopusteno } = ostaleMetode("POST, OPTIONS");
export { OPTIONS, nedopusteno as GET, nedopusteno as PUT, nedopusteno as PATCH, nedopusteno as DELETE };
