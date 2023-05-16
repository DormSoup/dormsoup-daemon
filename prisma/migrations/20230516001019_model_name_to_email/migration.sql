/*
  Warnings:

  - You are about to drop the column `modelName` on the `Event` table. All the data in the column will be lost.
  - You are about to drop the column `summary` on the `Event` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Email" ADD COLUMN     "modelName" TEXT;

-- AlterTable
ALTER TABLE "Event" DROP COLUMN "modelName",
DROP COLUMN "summary";
