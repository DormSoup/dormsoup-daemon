import { PrismaClient } from "@prisma/client";

/**
 * Deletes all records from the `event` table in the database.
 * 
 * This function establishes a connection to the database using Prisma,
 * deletes all entries in the `event` table, and then disconnects from the database.
 * 
 * @throws Will throw an error if the database operation fails.
 */
export async function main() {
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    await prisma.event.deleteMany();
  } finally {
    await prisma.$disconnect();
  }
}

await main();
