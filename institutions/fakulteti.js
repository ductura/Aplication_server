// Faculties of the University of Zagreb as listed on unizg.hr
// (data/fakulteti.json). One institution is one faculty.
import doc from "./data/fakulteti.json" with { type: "json" };

export const IZVOR = doc.izvor;
export const FAKULTETI = Object.freeze(doc.fakulteti.map((f) => Object.freeze({ ...f })));

const PO_ID = new Map(FAKULTETI.map((f) => [f.id, f]));

export function nadjiFakultet(id) {
  return typeof id === "string" ? (PO_ID.get(id) ?? null) : null;
}
