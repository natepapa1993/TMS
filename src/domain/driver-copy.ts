/**
 * What we text a driver, in the language they read (m22): a Mexican driver — a B-1 or dual-licence driver, a
 * Mexican licence on file, or a +52 phone — gets it in Spanish first; the others in English. A partner carrier's
 * driver follows the carrier's country. Pure: the dispatch actions and the board share it.
 */
export type DriverLike = { driverType?: string | null; phone?: string | null; whatsapp?: string | null; mxLicenseNumber?: string | null; mxLicenseExpires?: unknown };

export function driverReadsSpanish(d: DriverLike): boolean {
  const t = String(d.driverType ?? "").toUpperCase();
  if (t === "B1" || t === "DUAL") return true;
  if (d.mxLicenseNumber || d.mxLicenseExpires) return true;
  return [d.whatsapp, d.phone].some((p) => /^\+?\s*52\b|^\+?52\s?[1-9]/.test(String(p ?? "").trim()));
}

/** Our driver's app link: "Óscar Peña, tus cargas · your loads: https://…" */
export function driverLinkText(name: string, url: string, es: boolean) {
  return es ? `${name}, tus cargas · your loads: ${url}` : `${name}, your loads: ${url}`;
}

/** A partner carrier's driver, one load: the steps page. */
export function carrierDriverLinkText(name: string, orderNumber: string, url: string, es: boolean) {
  return es ? `${name}, carga ${orderNumber} — un botón por paso, déjalo abierto mientras manejas: ${url}` : `${name}, load ${orderNumber} — one button per step, keep it open while driving: ${url}`;
}
