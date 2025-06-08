import { PrismaClient } from "@prisma/client";

// TODO: Comment this
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
