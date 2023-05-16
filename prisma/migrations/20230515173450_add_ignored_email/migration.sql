-- CreateTable
CREATE TABLE "IgnoredEmail" (
    "scrapedBy" TEXT NOT NULL,
    "uid" INTEGER NOT NULL,
    "messageId" TEXT NOT NULL,

    CONSTRAINT "IgnoredEmail_pkey" PRIMARY KEY ("messageId")
);
