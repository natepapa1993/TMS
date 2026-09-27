import { NextResponse, type NextRequest } from "next/server";

/** Optimistic auth check: no session cookie → /login. Real authorization happens in every server function. */
export function proxy(request: NextRequest) {
  const has = request.cookies.has("tms_session");
  const { pathname } = request.nextUrl;
  const isAuthPage = pathname === "/login" || pathname === "/signup";
  const isPublic = /^\/(t|d|p|i|c|cp|track)\//.test(pathname) || pathname.startsWith("/api/");
  // a server action from a page whose session expired: let it reach act(), which answers "You are signed out" in the form instead of a crashed page
  const isAction = request.method === "POST" && request.headers.has("next-action");
  if (!has && !isAuthPage && !isPublic && !isAction && pathname !== "/") {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  if (has && isAuthPage) return NextResponse.redirect(new URL("/dispatch", request.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
