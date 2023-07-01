import { PrismaClient } from "@prisma/client";

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
