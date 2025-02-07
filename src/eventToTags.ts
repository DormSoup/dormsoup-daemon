import { PrismaClient } from "@prisma/client";

import { CURRENT_MODEL_NAME, addTagsToEvent } from "./llm/eventToTags.js";

/**
 * Updates existing events' tags if they are in the last lookbackDays and haven't been tagged with
 * the current tagging model
 * @param lookbackDays how far to look back for events with outdated tags
 */
export default async function addTagsToEvents(lookbackDays: number = 60) {
  const prisma = new PrismaClient();

  try {
    const since = new Date();
    since.setDate(new Date().getDate() - lookbackDays);
    const events = await prisma.event.findMany({
      where: {
        date: { gte: since },
        OR: [
          { tagsProcessedBy: { not: { equals: CURRENT_MODEL_NAME } } },
          { tagsProcessedBy: { equals: null } }
        ]
      }
    });
    console.log(`Need to tag ${events.length} event.`);
    await Promise.allSettled(
      events.map((event) =>
        (async () => {
          await prisma.event.update({
            where: { id: event.id },
            data: { tagsProcessedBy: CURRENT_MODEL_NAME + "_PROCESSING", tags: { set: [] } }
          });

          const tags = await addTagsToEvent(event);
          console.log(`Event "${event.title}" has tags: ${tags}`);

          for (const tag of tags) {
            await prisma.event.update({
              where: { id: event.id },
              data: {
                tags: {
                  connectOrCreate: {
                    where: { name: tag },
                    create: {
                      name: tag,
                      color: "",
                      icon: "",
                      category: ""
                    }
                  }
                }
              }
            });
          }

          await prisma.event.update({
            where: { id: event.id },
            data: { tagsProcessedBy: CURRENT_MODEL_NAME }
          });
        })()
      )
    );
  } finally {
    await prisma.$disconnect();
  }
}
