/**
 * Where each role starts its day (owner top-15 #6, billing #44): the owner on Today, billing on the
 * billing queue, Safety on compliance, dispatch on the board, the Mexico office on crossings.
 */
export function homeFor(role: string | null | undefined): string {
  switch (role) {
    case "owner":
      return "/today";
    case "billing":
      return "/billing";
    case "compliance":
      return "/compliance";
    case "mx_office":
      return "/crossing";
    default:
      return "/dispatch";
  }
}
