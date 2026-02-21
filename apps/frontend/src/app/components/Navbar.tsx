'use client';

import { SignedIn, SignedOut, UserButton } from '@clerk/nextjs';
import { Box, Button, Flex, HStack } from '@chakra-ui/react';
import { clerkEnabled } from '../../providers/auth-provider';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import { useImpersonation } from '../../providers/impersonation-provider';
import { AdminImpersonationModal } from './AdminImpersonationModal';
import { SettingsModal } from './SettingsModal';
import { FiSettings } from 'react-icons/fi';

export const Navbar = ({ rightElement, centerElement }: { rightElement?: React.ReactNode; centerElement?: React.ReactNode }) => {
  const [mounted, setMounted] = useState(false);
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { isAdmin, impersonatedEmail } = useImpersonation();

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <Box as="header" bg="app.bg">
      <Flex justify="space-between" align="center" px={6} py={4} position="relative">
        <Flex align="center" gap={4}>
          <a href="/">
            <Image src="/brand/logo-dark.png" alt="Automated" width={120} height={25} priority />
          </a>

          <a href="/">
            <Button size="md" fontSize="md" color="black" variant="outline" border="none">
              Workflows
            </Button>
          </a>
        </Flex>
        {centerElement && (
          <Box
            position="absolute"
            left="50%"
            top="50%"
            transform="translate(-50%, -50%)"
            zIndex={1}
            animation="transcript-pill-slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards"
          >
            {centerElement}
          </Box>
        )}
        <HStack gap={4} color="app.snow">
          {rightElement ? (
            rightElement
          ) : !mounted ? (
            <Box h="10" />
          ) : (
            <>
              {clerkEnabled ? (
                <>
                  <SignedOut>
                    <a href="/login">
                      <Button size="sm" variant="outline" borderColor="app.border">
                        Log in
                      </Button>
                    </a>
                    <a href="/signup">
                      <Button
                        size="sm"
                        bg="app.primary"
                        color="app.onPrimary"
                        _hover={{ bg: 'app.primaryAlt' }}
                      >
                        Sign up
                      </Button>
                    </a>
                  </SignedOut>
                  <SignedIn>
                    {isAdmin && (
                      <Button
                        size="sm"
                        variant="outline"
                        borderColor={impersonatedEmail ? 'red.500' : 'app.border'}
                        color={impersonatedEmail ? 'red.400' : undefined}
                        onClick={() => setAdminModalOpen(true)}
                      >
                        {impersonatedEmail ? `Admin (${impersonatedEmail})` : 'Admin'}
                      </Button>
                    )}
                    <UserButton afterSignOutUrl="/" />
                  </SignedIn>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  borderColor="app.border"
                  onClick={() => setSettingsOpen(true)}
                  aria-label="Settings"
                >
                  <FiSettings />
                </Button>
              )}
            </>
          )}
        </HStack>
      </Flex>
      <AdminImpersonationModal
        isOpen={adminModalOpen}
        onClose={() => setAdminModalOpen(false)}
      />
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Box>
  );
};
