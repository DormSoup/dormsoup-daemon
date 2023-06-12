/*
  Warnings:

  - Made the column `fromEmailId` on table `Event` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "Event" DROP CONSTRAINT "Event_fromEmailId_fkey";

-- DropIndex
DROP INDEX "Event_fromEmailId_key";

-- AlterTable
ALTER TABLE "Event" ALTER COLUMN "fromEmailId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_fromEmailId_fkey" FOREIGN KEY ("fromEmailId") REFERENCES "Email"("messageId") ON DELETE RESTRICT ON UPDATE CASCADE;
