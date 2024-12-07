import { simpleParser } from "mailparser";
import fs from 'node:fs';
import path from 'node:path';

import { processNewEmail } from "../emailToEvents.js";
import { flushEmbeddings, loadEmbeddings } from "../vectordb.js";

async function main(): Promise<void> {
    const folderWithTests = "src/scripts/FolderwithTestEmail";
    const folderPath = process.argv[2] || folderWithTests;

    if (!fs.existsSync(folderPath) || !fs.lstatSync(folderPath).isDirectory()) {
        console.error("Provided path is not a valid folder");
        process.exit(1);
    }
    const files = fs.readdirSync(folderPath);
    loadEmbeddings();
    for (const file of files) {
        const filePath = path.join(folderPath, file);
        const contents = fs.readFileSync(filePath);
        const parsed = await simpleParser(contents, {
            skipImageLinks: true,
            skipHtmlToText: false
        });
        await processNewEmail(parsed);
        console.log("Successfully inserted email into the database");
    }
    flushEmbeddings();
}
await main();
