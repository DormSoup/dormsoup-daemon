/*
  Warnings:

  - The primary key for the `IgnoredEmail` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `messageId` on the `IgnoredEmail` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[scrapedBy,uid]` on the table `IgnoredEmail` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `receivedAt` to the `IgnoredEmail` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "IgnoredEmail" DROP CONSTRAINT "IgnoredEmail_pkey",
DROP COLUMN "messageId",
ADD COLUMN     "receivedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "IgnoredEmail_scrapedBy_uid_key" ON "IgnoredEmail"("scrapedBy", "uid");
