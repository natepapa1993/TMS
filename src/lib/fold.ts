/**
 * Accent- and case-folding for search and name matching: "Óscar" = "oscar", "Bajío" = "bajio",
 * "Héctor" = "hector", "Querétaro" = "queretaro". The same letters are folded in SQL with translate(),
 * so a search needs no database extension.
 */

export const ACCENTED = "áàâäãåéèêëíìîïóòôöõúùûüñçÁÀÂÄÃÅÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇ";
export const PLAIN = "aaaaaaeeeeiiiiooooouuuuncaaaaaaeeeeiiiiooooouuuunc";

/** Lower case with the accents taken off. */
export function fold(s: string | null | undefined): string {
  if (!s) return "";
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Does `hay` contain `needle`, ignoring case and accents? */
export function foldIncludes(hay: string | null | undefined, needle: string | null | undefined): boolean {
  const n = fold(needle).trim();
  if (!n) return true;
  return fold(hay).includes(n);
}
