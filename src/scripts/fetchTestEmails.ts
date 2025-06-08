import { PrismaClient } from '@prisma/client';
import { writeFile } from 'fs/promises';

const prisma = new PrismaClient();

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
