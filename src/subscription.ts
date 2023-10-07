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
  let screenshot: string | undefined;
  try {
    screenshot = await generateThumbnail(today);
  } catch {}
  const content = await composeEmail(today, events, screenshot);
  const prisma = new PrismaClient();
  const users = (await prisma.emailSender.findMany({ where: { subscribed: true } })).map(
    ({ email }) => email
  );
  for (const user of ["macy404@mit.edu", "andiliu@mit.edu"]) {
    await sendEmail({
      ...content,
      to: user
    });
  }
  console.log(`Pushed to ${users.length} subscribers`);
}

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

async function composeEmail(
  today: Date,
  events: Awaited<ReturnType<typeof getAllEvents>>,
  screenshot?: string
) {
  const subject = "[Happening Tomorrow] " + events.map(({ title }) => title).join(", ");
  const isAllDay = (date: Date) => date.getHours() === 0 && date.getMinutes() === 0;
  const paragraphs = events.map((event) => {
    return PUSH_EVENT_TEMPLATE.replace("{EVENT_TITLE}", event.title)
      .replace("{EVENT_TIME}", isAllDay(event.date) ? "All day" : event.date.toLocaleTimeString())
      .replace("{EVENT_LOCATION}", event.location)
      .replace("{EVENT_TAGS}", event.tags.map(({ name }) => name).join(", "));
  });
  const html = screenshot
    ? PUSH_TEMPLATE.replace("{EVENTS}", `<img src="${screenshot}" style="width:100%" />`)
    : PUSH_TEMPLATE.replace("{EVENTS}", paragraphs.join("\n"));
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
