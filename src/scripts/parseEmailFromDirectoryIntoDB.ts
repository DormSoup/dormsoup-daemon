/// Parse an email from standard input, thus avoiding to authenticate to Outlook/Office365
import { PrismaClient } from "@prisma/client";
import fs from 'node:fs';
import * as readline from 'readline';
import { simpleParser } from "mailparser";
import { processNewEmail } from "../emailToEvents";


/**
 * Main entry point for the CLI script that parses .eml files from a directory and inserts
 * events derived from those emails into a database.
 * @async
 * @returns Promise<void> A promise that resolves when processing is complete and resources have been cleaned up.
 * @throws {Error} If required environment variables (DATABASE_URL, SMTP_KERB, SMTP_PASS) are not present.
 */
async function main(): Promise<void> {
    process.env.DEBUG_MODE = "true";
    let directory: string;
    // just in case
    if (process.argv[0].includes("node")) {
        directory = process.argv[2];
    } else {
        directory = process.argv[1];
    }
    if (directory === undefined) {
        console.error("Usage: npm run parseEmailFromFile directory")
        console.error("directory may be the path to a directory with .eml files")
        process.exit(1);
    }
    if (!fs.existsSync(directory)) {
        console.error(`Directory not found: ${directory}`);
        process.exit(1);
    }
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        throw new Error("DATABASE_URL not found in environment variables");
    }
    console.log('The DB URL is', dbUrl, 'are you sure you want to insert the event into the database?')
    
    const SMTP_KERB = process.env.SMTP_KERB;
    if (!SMTP_KERB) {
        throw new Error("SMTP_KERB not found in environment variables (this is used to send the notification email to the sender).");
    }
    const SMTP_PASS = process.env.SMTP_PASS;
    if (!SMTP_PASS) {
        throw new Error("SMTP_PASS not found in environment variables (this is used to send the notification email to the sender).");
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    const answer = await new Promise<string>((resolve) => {
        rl.question('Are you sure you want to insert the event into the database? (y/n): ', resolve);
    });
    
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log('Aborting insertion.');
        return;
    }

    const assumeHasEventsAnswer = await new Promise<string>((resolve) => {
        rl.question('Would you like for the LLM to assume all the emails have events? (y/n): ', resolve);
    });

    const assumeHasEvents = assumeHasEventsAnswer === 'y' || assumeHasEventsAnswer === 'yes'

    rl.close();

    const prisma = new PrismaClient();
    try {
        console.log('Connecting to DB...');
        await prisma.$connect();
        console.log('Connected to DB.');

        const fileNames = fs.readdirSync(directory).filter(file => file.endsWith('.eml'));
        for (const file of fileNames) {
            const filePath = `${directory}/${file}`;
            console.log(`Parsing ${filePath.slice(0, -4)}...\n`);
            const contents = fs.readFileSync(filePath);
            const parsed = await simpleParser(contents, {
                skipImageLinks: true,
                skipHtmlToText: false
            });
            await processNewEmail(parsed, assumeHasEvents);
            
        }
    }
    finally {
        await prisma.$disconnect();
  }

}

await main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });