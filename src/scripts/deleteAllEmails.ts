import { PrismaClient } from "@prisma/client";

/**
 * Deletes all records from the `event` and `email` tables in the database.
 * 
 * This function establishes a connection to the database using Prisma,
 * deletes all entries from the `event` and `email` tables, and then
 * disconnects from the database. It ensures that the database connection
 * is properly closed even if an error occurs during the deletion process.
 *
 * @returns {Promise<void>} A promise that resolves when the deletion is complete.
 */
export async function main() {
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    await prisma.event.deleteMany();
    await prisma.email.deleteMany();
  } finally {
    await prisma.$disconnect();
  }
}

await main();
