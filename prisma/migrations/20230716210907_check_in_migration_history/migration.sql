/*
  Warnings:

  - A unique constraint covering the columns `[scrapedBy,uid]` on the table `Email` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `text` to the `Event` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "duration" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "tagsProcessedBy" TEXT,
ADD COLUMN     "text" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "Tag" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "color" TEXT NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_EventToTag" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "_EmailSenderToEvent" (
    "A" TEXT NOT NULL,
    "B" INTEGER NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Tag_name_key" ON "Tag"("name");

-- CreateIndex
CREATE UNIQUE INDEX "_EventToTag_AB_unique" ON "_EventToTag"("A", "B");

-- CreateIndex
CREATE INDEX "_EventToTag_B_index" ON "_EventToTag"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_EmailSenderToEvent_AB_unique" ON "_EmailSenderToEvent"("A", "B");

-- CreateIndex
CREATE INDEX "_EmailSenderToEvent_B_index" ON "_EmailSenderToEvent"("B");

-- CreateIndex
CREATE UNIQUE INDEX "Email_scrapedBy_uid_key" ON "Email"("scrapedBy", "uid");

-- AddForeignKey
ALTER TABLE "_EventToTag" ADD CONSTRAINT "_EventToTag_A_fkey" FOREIGN KEY ("A") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EventToTag" ADD CONSTRAINT "_EventToTag_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EmailSenderToEvent" ADD CONSTRAINT "_EmailSenderToEvent_A_fkey" FOREIGN KEY ("A") REFERENCES "EmailSender"("email") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EmailSenderToEvent" ADD CONSTRAINT "_EmailSenderToEvent_B_fkey" FOREIGN KEY ("B") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
