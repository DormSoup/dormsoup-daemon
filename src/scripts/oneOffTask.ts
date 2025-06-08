import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
// @ts-ignore
import nodemailerNTLMAuth from "nodemailer-ntlm-auth";
import puppeteer from "puppeteer";

import { authenticate } from "../auth.js";
import { createEmbedding, removeArtifacts } from "../llm/utils.js";
import { sendEmail } from "../mailer.js";
import {
  flushEmbeddings,
  getDistance,
  getEmbedding,
  getKNearestNeighbors,
  loadEmbeddings,
  upsertEmbedding
} from "../vectordb.js";

// TODO: Comment this
export async function main() {
  dotenv.config();
  // const prisma = new PrismaClient();
  await loadEmbeddings();
  // await prisma.$connect();
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const key = "Fri, Oct 6";

    // Navigate the page to a URL
    await page.setViewport({ width: 768, height: 1024, deviceScaleFactor: 2 });
    await page.goto("http://localhost:3001/");
    console.log("Waiting");
    await page.waitForFunction(`document.querySelector("body").innerText.includes("${key}")`);
    await page.screenshot({ path: "screenshot.png" });
    const [region] = await page.$x(`//div[@class='flex w-full flex-col'][contains(., '${key}')]`);
    await region.screenshot({ path: "region.png" });
  } finally {
    await browser.close();
    // await flushEmbeddings();
    // await prisma.$disconnect();
  }
}

await main();
