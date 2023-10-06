import { PrismaClient } from "@prisma/client";
import dedent from "dedent";
import fs from "fs";

import { sendEmail } from "./mailer.js";

const PUSH_DATE_FILE = "./push.date";

function roundToDate(date: Date | undefined) {
  if (!date) return undefined;
  const newDate = new Date(date);
  newDate.setHours(0, 0, 0, 0);
  return newDate;
}

export async function pushToSubscribers() {
  const today = new Date();
  if (roundToDate(today)?.getTime() === roundToDate(await getMostRecentPushDate())?.getTime())
    return;
  await fs.promises.writeFile(PUSH_DATE_FILE, today.toISOString());

  console.log("Pushing to subscribers");
  const events = await getAllEvents(today);
  if (events.length === 0) {
    console.log("No events tomorrow, skipping the push");
    return;
  }
  const content = await composeEmail(today, events);
  const prisma = new PrismaClient();
  const users = (await prisma.emailSender.findMany({ where: { subscribed: true } })).map(({email}) => email);
  for (const user of users) {
    await sendEmail({
      ...content,
      to: user
    });
  }
  console.log("Pushed");
}

async function getAllEvents(today: Date) {
  const prisma = new PrismaClient();
  try {
    const events = await prisma.event.findMany({
      where: {
        date: {
          gte: new Date(today.getTime() + 0 * 60 * 60 * 1000),
          lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
        }
      },
      select: {
        title: true,
        date: true,
        location: true,
        organizer: true,
        tags: { select: { name: true } },
        fromEmail: { select: { receivedAt: true } }
      },
      orderBy: {
        liked: {
          _count: "desc"
        }
      }
    });
    return events;
  } catch {
    return [];
  } finally {
    await prisma.$disconnect();
  }
}

const PUSH_TEMPLATE = dedent`
<body>
  <p>
    Events happening tomorrow:
  </p>
  {EVENTS}
  <p>
    If you have any questions, you can contact <a href="mailto:dormsoup@mit.edu">dormsoup@mit.edu</a>. You can also <a href="https://dormsoup.mit.edu">visit our website</a> to for event details or to unsubscribe.
  </p>
</body>
`;
const PUSH_EVENT_TEMPLATE = dedent`
  <p>
    <h2 style="display:inline;">{EVENT_TITLE}</h2>&nbsp;
    {EVENT_TIME} @ {EVENT_LOCATION} <br>
    Tags: {EVENT_TAGS}
  </p>
  `;

async function composeEmail(today: Date, events: Awaited<ReturnType<typeof getAllEvents>>) {
  const subject = "[Happening Tomorrow] " + events.map(({ title }) => title).join(", ");
  const isAllDay = (date: Date) => date.getHours() === 0 && date.getMinutes() === 0;
  const paragraphs = events.map((event) => {
    return PUSH_EVENT_TEMPLATE.replace("{EVENT_TITLE}", event.title)
      .replace("{EVENT_TIME}", isAllDay(event.date) ? "All day" : event.date.toLocaleTimeString())
      .replace("{EVENT_LOCATION}", event.location)
      .replace("{EVENT_TAGS}", event.tags.map(({ name }) => name).join(", "));
  });
  const html = PUSH_TEMPLATE.replace("{EVENTS}", paragraphs.join("\n"));
  return { subject, html };
}

async function getMostRecentPushDate(): Promise<Date | undefined> {
  // Returns undefined if the file doesn't exist
  if (
    !(await fs.promises
      .access(PUSH_DATE_FILE, fs.constants.F_OK)
      .then(() => true)
      .catch(() => false))
  )
    return undefined;
  const dateContent = (await fs.promises.readFile(PUSH_DATE_FILE, "utf-8")).trim();
  try {
    return new Date(dateContent);
  } catch {
    return undefined;
  }
}
