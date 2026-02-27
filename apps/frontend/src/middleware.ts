import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";

const clerkEnabled = false; // !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export default async function middleware(request: NextRequest, event: NextFetchEvent) {
  if (!clerkEnabled) {
    return NextResponse.next();
  }

  const { clerkMiddleware, createRouteMatcher } = await import("@clerk/nextjs/server");

  const isProtectedRoute = createRouteMatcher([
    '/record(.*)',
    '/workflow(.*)',
  ]);

  return clerkMiddleware(async (auth, req) => {
    if (isProtectedRoute(req)) {
      await auth.protect();
    }
  })(request, event);
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
