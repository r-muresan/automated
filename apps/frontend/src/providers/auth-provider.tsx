'use client';

import { ClerkProvider, useAuth, useUser, useClerk } from '@clerk/nextjs';
import type { ReactNode } from 'react';

export const clerkEnabled = false; // !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export function AuthProvider({ children }: { children: ReactNode }) {
  if (clerkEnabled) {
    return <ClerkProvider>{children}</ClerkProvider>;
  }
  return <>{children}</>;
}

const noopAuth = {
  isLoaded: true,
  isSignedIn: true,
  getToken: async () => null,
} as const;

export function useOptionalAuth() {
  if (clerkEnabled) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useAuth();
  }
  return noopAuth;
}

const localUser = {
  user: {
    primaryEmailAddress: { emailAddress: 'local@localhost' },
  },
} as const;

export function useOptionalUser() {
  if (clerkEnabled) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useUser();
  }
  return localUser;
}

const noopClerk = {
  redirectToSignIn: () => {},
  redirectToSignUp: () => {},
  openSignIn: () => {},
  openSignUp: () => {},
} as const;

export function useOptionalClerk() {
  if (clerkEnabled) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useClerk();
  }
  return noopClerk;
}
