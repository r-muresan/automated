-- Persist Browserbase regional connect URL per session so reconnects can use
-- the correct endpoint even after backend restarts.
ALTER TABLE "BrowserSession"
ADD COLUMN "connectUrl" TEXT;
