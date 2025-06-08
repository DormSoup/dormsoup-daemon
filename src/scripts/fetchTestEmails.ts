import { PrismaClient } from '@prisma/client';
import { writeFile } from 'fs/promises';

const prisma = new PrismaClient();

/**
 * Retrieves two sets of emails from the database: one set containing emails associated with events,
 * and another set containing emails without any associated events. For emails with events, it also
 * aggregates unique tag names from all related events and attaches them as a `tags` array to each email.
 * The results are saved as JSON files in the `testEmails` directory.
 *
 * @async
 * @function
 * @returns {Promise<void>} Resolves when the emails have been fetched and written to files.
 *
 * @remarks
 * - Fetches up to 10 emails with events and 10 emails without events.
 * - For emails with events, includes event details and their associated tag names.
 * - Writes the results to `emails_with_events.json` and `emails_without_events.json`.
 * - Logs a message upon successful completion.
 */
async function getEmailsWithAndWithoutEvents() {
  const emailsWithEvents = await prisma.email.findMany({
    where: {
      event: {
        some: {},
      },
    },
    take: 10,
    include: {
      event: {
        include: {
          tags: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  });

  // Add .tags array to each email based on its events' tags
  const emailsWithEventsTagged = emailsWithEvents.map(email => {
    const tagSet = new Set();
    for (const event of email.event) {
      for (const tag of event.tags) {
        tagSet.add(tag.name);
      }
    }
    return {
      ...email,
      tags: Array.from(tagSet),
    };
  });

  const emailsWithoutEvents = await prisma.email.findMany({
    where: {
      event: {
        none: {},
      },
    },
    take: 10,
  });

  await writeFile('testEmails/emails_with_events.json', JSON.stringify(emailsWithEventsTagged, null, 2));
  await writeFile('testEmails/emails_without_events.json', JSON.stringify(emailsWithoutEvents, null, 2));

  console.log('Saved 10 emails with events and 10 without events to JSON files.');
}

await getEmailsWithAndWithoutEvents()
  .catch((e) => {
    console.error('Error fetching emails:', e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
