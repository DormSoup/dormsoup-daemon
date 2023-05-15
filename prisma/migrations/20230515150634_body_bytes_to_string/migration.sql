-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('DORMSPAM');

-- CreateTable
CREATE TABLE "Event" (
    "id" SERIAL NOT NULL,
    "source" "DataSource" NOT NULL,
    "fromEmailId" TEXT,
    "title" TEXT NOT NULL,
    "organizer" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "location" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Email" (
    "scrapedBy" TEXT NOT NULL,
    "uid" INTEGER NOT NULL,
    "messageId" TEXT NOT NULL,
    "inReplyToId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "body" TEXT NOT NULL,

    CONSTRAINT "Email_pkey" PRIMARY KEY ("messageId")
);

-- CreateTable
CREATE TABLE "EmailSender" (
    "email" TEXT NOT NULL,
    "name" TEXT,

    CONSTRAINT "EmailSender_pkey" PRIMARY KEY ("email")
);

-- CreateIndex
CREATE UNIQUE INDEX "Event_fromEmailId_key" ON "Event"("fromEmailId");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_fromEmailId_fkey" FOREIGN KEY ("fromEmailId") REFERENCES "Email"("messageId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_inReplyToId_fkey" FOREIGN KEY ("inReplyToId") REFERENCES "Email"("messageId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_senderEmail_fkey" FOREIGN KEY ("senderEmail") REFERENCES "EmailSender"("email") ON DELETE RESTRICT ON UPDATE CASCADE;
