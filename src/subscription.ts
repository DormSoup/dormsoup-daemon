import { PrismaClient } from "@prisma/client";
import { spawn } from "child_process";
import dedent from "dedent";
import fs from "fs";
import jimp from "jimp";
import { resolve } from "path";
import puppeteer from "puppeteer";
import { sendEmail } from "./mailer.js";

const PUSH_DATE_FILE = "./push.date";
const THUMBNAIL_PORT = 3001;
const FRONTEND_PATH = "../dormsoup";

/**
 * Rounds a given Date object down to the start of the day (midnight).
 *
 * @param date - The Date object to round.
 * @returns A new Date object set to 00:00:00.000 of the same day as the input.
 */
function roundToDate(date: Date) {
  const newDate = new Date(date);
  newDate.setHours(0, 0, 0, 0);
  return newDate;
}

/**
 * Pushes event notifications to all subscribed users via email.
 *
 * This function checks if a push has already been made today by comparing the current date
 * with the most recent push date. If a push has already occurred, it exits early.
 * Otherwise, it writes the current date as the new push date, retrieves all events for today,
 * and, if there are any events, generates a thumbnail screenshot (if possible) and composes
 * an email with the event information. It then fetches all subscribed users from the database
 * and sends the composed email to each subscriber.
 *
 * Logs the process and skips sending if there are no events for the day.
 * @returns {Promise<void>} Resolves when the push process is complete.
 */
export async function pushToSubscribers() {
  const today = new Date();
  const lastPushDate = await getMostRecentPushDate();
  // If today's push has already occurred, it exit early.
  if (roundToDate(today).getTime() === roundToDate(lastPushDate).getTime())
    return;
  await fs.promises.writeFile(PUSH_DATE_FILE, today.toISOString());

  console.log("Pushing to subscribers");
  const events = await getAllEvents(today);
  if (events.length === 0) {
    console.log("No events tomorrow, skipping the push");
    return;
  }
  let screenshot: string | undefined;
  try {
    screenshot = await generateThumbnail(today);
  } catch {}
  const content = await composeEmail(events, screenshot);
  const prisma = new PrismaClient();
  const users = (await prisma.emailSender.findMany({ where: { subscribed: true } })).map(
    ({ email }) => email
  );
  for (const user of users) {
    await sendEmail({
      ...content,
      to: user
    });
  }
  console.log(`Pushed to ${users.length} subscribers`);
}


/**
 * Generates a thumbnail image (of the Dormsoup site) for the given date by launching a frontend server,
 * rendering the page with Puppeteer, and extracting a specific region containing the date.
 * The function processes the screenshot to adjust background colors and returns the result as a base64-encoded PNG.
 *
 * @param today - The date for which to generate the thumbnail.
 * @returns A promise that resolves to a base64-encoded PNG image string.
 * @throws If the target region containing the date is not found on the rendered page.
 */
async function generateThumbnail(today: Date): Promise<string> {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  };
  const key = today.toLocaleDateString("en-US", options);

  // Launch child process to start thumbnail server
  const frontEndCwd = resolve(FRONTEND_PATH);
  const frontEnd = spawn("npx", ["next", "start", "--port", `${THUMBNAIL_PORT}`], {
    cwd: frontEndCwd,
    env: { ...process.env, DORMSOUP_THUMBNAIL: "1" }
  });
  // frontEnd.stderr.on("data", (data) => console.warn(data.toString()));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const browser = await puppeteer.launch({ headless: "new" });
  try {
    const page = await browser.newPage();
    // Navigate the page to a URL
    await page.setViewport({ width: 640, height: 1024, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${THUMBNAIL_PORT}/`);
    await page.screenshot({ path: "screenshot.png" });
    await page.waitForFunction(`document.querySelector("body").innerText.includes("${key}")`, {
      timeout: 10000
    });
    const [region] = await page.$x(`//div[@class='flex w-full flex-col'][contains(., '${key}')]`);
    if (region) {
      await region.screenshot({ path: "region.png" });
      const image = await jimp.read("region.png");
      image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
        const r = image.bitmap.data[idx + 0];
        const g = image.bitmap.data[idx + 1];
        const b = image.bitmap.data[idx + 2];
        const dist = Math.sqrt((r - 229) ** 2 + (g - 231) ** 2 + (b - 235) ** 2);
        if (dist <= 31 && !(r === 209 && g === 213 && b === 219)) {
          // Set to white
          image.bitmap.data[idx + 0] = 255;
          image.bitmap.data[idx + 1] = 255;
          image.bitmap.data[idx + 2] = 255;
        }
      });
      return await image.getBase64Async(jimp.MIME_PNG);
    } else {
      console.error("Failed to generate screenshot: region not found");
      throw new Error("Failed to generate screenshot: region not found");
    }
  } finally {
    await browser.close();
    frontEnd.kill("SIGINT");
  }
}

/**
 * Retrieves all events occurring on the specified day.
 *
 * Queries the database for events whose `date` falls within the 24-hour period
 * starting from the provided `today` date. The returned events include selected fields
 * such as `id`, `title`, `date`, `location`, `organizer`, associated `tags`, 
 * the `receivedAt` timestamp from the related `fromEmail`, and `gcalId`.
 * Results are ordered by the number of likes in descending order.
 *
 * @param today - The date representing the start of the day for which to fetch events.
 * @returns A promise that resolves to an array of event objects matching the criteria.
 */
export async function getAllEvents(today: Date) {
  const prisma = new PrismaClient();
  try {
    const events = await prisma.event.findMany({
      where: {
        date: {
          gte: new Date(today.getTime()),
          lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
        }
      },
      select: {
        id: true,
        title: true,
        date: true,
        location: true,
        organizer: true,
        tags: { select: { name: true } },
        fromEmail: { select: { receivedAt: true } },
        gcalId: true
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


/**
 * Composes an email with a subject and HTML body summarizing upcoming events.
 *
 * @param events - An array of event objects returned by `getAllEvents`.
 * @param screenshot - (Optional) A base64-encoded image string to include in the email body.
 * @returns An object containing the email subject and HTML content.
 */
async function composeEmail(
  events: Awaited<ReturnType<typeof getAllEvents>>,
  screenshot?: string
) {
  const subject = "[Happening Tomorrow] " + events.map(({ title }) => title).join(", ");
  const isAllDay = (date: Date) => date.getUTCHours() === 0 && date.getUTCMinutes() === 0;

  const paragraphs = events.map((event) => {
    return PUSH_EVENT_TEMPLATE.replace("{EVENT_TITLE}", event.title)
      .replace(
        "{EVENT_TIME}",
        isAllDay(event.date)
          ? "All day"
          : event.date.toLocaleTimeString("en-US", {
              timeZone: "UTC",
              hour12: true,
              hour: "2-digit",
              minute: "2-digit"
            })
      )
      .replace("{EVENT_LOCATION}", event.location)
      .replace("{EVENT_TAGS}", event.tags.map(({ name }) => name).join(", "));
  });

  const html = screenshot
    ? PUSH_TEMPLATE.replace("{EVENTS}", `<img src="${screenshot}" style="width:100%" />`)
    : PUSH_TEMPLATE.replace("{EVENTS}", paragraphs.join("\n"));

  return { subject, html };
}

/**
 * Retrieves the last date we pushed the daily scoop to subscribers from the PUSH_DATE_FILE.
 * If the PUSH_DATE_FILE exists, it reads its contents, trims any whitespace, and attempts to parse it as a `Date`.
 * If the PUSH_DATE_FILE does not exist or the contents cannot be parsed as a valid date, 
 * the function returns the date object representing January 1, 1970, 00:00:00 UTC.
 * @returns {Promise<Date>} A promise that resolves to the last push date as a `Date` object,
 * or January 1, 1970, 00:00:00 UTC if the file does not exist or the date is invalid.
 */
async function getMostRecentPushDate(): Promise<Date> {
  // Return earliest date if the file doesn't exist
  if (
    !(await fs.promises
      .access(PUSH_DATE_FILE, fs.constants.F_OK)
      .then(() => true)
      .catch(() => false))
  )
    {
      return new Date(0);
    }
  const dateContent = (await fs.promises.readFile(PUSH_DATE_FILE, "utf-8")).trim();
  try {
    return new Date(dateContent);
  } catch {
    return new Date(0);
  }
}
