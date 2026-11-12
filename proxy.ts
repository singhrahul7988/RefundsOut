import { NextResponse, type NextRequest } from "next/server";

// Passes the current path to server layouts so the sidebar can highlight the active step.
export function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/events/:path*"] };
