import { NextResponse, type NextRequest } from "next/server";

/** Optimistic auth check: no session cookie → /login. Real authorization happens in every server function. */
export function proxy(request: NextRequest) {
  const has = request.cookies.has("tms_session");
  const { pathname } = request.nextUrl;
  const isAuthPage = pathname === "/login" || pathname === "/signup";
  const isPublic = /^\/(t|d|p|i|c|track)\//.test(pathname) || pathname.startsWith("/api/");
  if (!has && !isAuthPage && !isPublic && pathname !== "/") {
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
