import {
    AuthorizationCodeRequest,
    AuthorizationUrlRequest,
    CryptoProvider,
    PublicClientApplication
} from "@azure/msal-node";
import {
    DataProtectionScope,
    IPersistenceConfiguration,
    PersistenceCachePlugin,
    PersistenceCreator
} from "@azure/msal-node-extensions";
import { PrismaClient } from "@prisma/client";
import assert from "assert";
import express from "express";
import asyncHandler from "express-async-handler";
import fs from "fs";
import HttpStatus from "http-status-codes";
import https from "https";
import { ImapFlow } from "imapflow";
import { ParsedMail, simpleParser } from "mailparser";

import { Event, extractFromEmail } from "./llm.js";

type AuthResult = { user: string; accessToken: string; expiresOn: number };

const NUM_OF_EMAILS_TO_FETCH = 20;

async function authenticate(): Promise<AuthResult> {
    const cachePath = ".token.json";
    const persistentConfig: IPersistenceConfiguration = {
        cachePath,
        dataProtectionScope: DataProtectionScope.CurrentUser,
        serviceName: "hakken",
        accountName: "ubuntu",
        usePlaintextFileOnLinux: true
    };
    const persistence = await PersistenceCreator.createPersistence(persistentConfig);

    const clientConfig = {
        auth: {
            // Shamelessly pillaged from Thunderbird.
            // See https://hg.mozilla.org/releases/comm-esr102/file/tip/mailnews/base/src/OAuth2Providers.jsm
            clientId: "9e5f94bc-e8a4-4e73-b8be-63364c29d753",
            authority: "https://login.microsoftonline.com/common"
        },
        cache: {
            cachePlugin: new PersistenceCachePlugin(persistence)
        }
    };
    const pca = new PublicClientApplication(clientConfig);
    const scopes = ["https://outlook.office.com/IMAP.AccessAsUser.All"];

    try {
        const accounts = await pca.getAllAccounts();
        if (accounts.length > 0) {
            console.log("Attempting to acquire token silently for user", accounts[0].username);
            const response = await pca.acquireTokenSilent({
                account: accounts[0],
                scopes
            });
            if (response !== null) {
                console.log("Acquired token silently for user", accounts[0].username);
                return {
                    user: response.account!.username,
                    accessToken: response.accessToken,
                    expiresOn: response.expiresOn!.getTime()
                };
            }
        }
    } catch {}
    console.log("No cache or silent flow failed. Starting interactive flow...");

    const redirectUri = `https://localhost`;
    const cryptoProvider = new CryptoProvider();
    const { verifier, challenge } = await cryptoProvider.generatePkceCodes();

    const authCodeRequest: AuthorizationUrlRequest = {
        scopes,
        redirectUri,
        codeChallenge: challenge,
        codeChallengeMethod: "S256"
    };

    let reject: (reason: any) => void;
    let resolve: (value: AuthResult | Promise<AuthResult>) => void;
    const promise = new Promise<AuthResult>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    const [privateKey, publicKey, _] = await Promise.all([
        fs.promises.readFile("selfsigned.key", "utf8"),
        fs.promises.readFile("selfsigned.crt", "utf8"),
        pca.getAuthCodeUrl(authCodeRequest).then((response) => {
            console.log(response);
        })
    ]);

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.get(
        "/",
        asyncHandler(async (req, res) => {
            const tokenRequest: AuthorizationCodeRequest = {
                code: req.query.code as string,
                scopes,
                redirectUri,
                codeVerifier: verifier,
                clientInfo: req.query.client_info as string
            };
            const response = await pca.acquireTokenByCode(tokenRequest);
            res.status(HttpStatus.OK).type("text").send(response.accessToken);
            server.close((error) => {
                if (error !== undefined) {
                    reject(error);
                    return;
                }
                console.log("Successfully authenticated");
                const result: AuthResult = {
                    user: response.account!.username,
                    accessToken: response.accessToken,
                    expiresOn: response.expiresOn!.getTime()
                };
                resolve(result);
            });
        })
    );
    const server = https.createServer({ key: privateKey, cert: publicKey }, app).listen(443);
    return promise;
}

export default async function main() {
    const client = new ImapFlow({
        host: "outlook.office365.com",
        port: 993,
        secure: true,
        auth: await authenticate(),
        logger: false
    });

    const prisma = new PrismaClient();
    const maxUid = (await prisma.email.aggregate({ _max: { uid: true } }))._max.uid ?? 0;
    await client.connect();

    let lock = await client.getMailboxLock("INBOX");
    try {
        assert(typeof client.mailbox !== "boolean");
        console.log(`Mailbox has ${client.mailbox.exists} messages`);
        const since = new Date();
        since.setDate(new Date().getDate() - 30);
        const uids = (await client.search({ sentSince: since }, { uid: true })).filter(
            (uid) => uid > maxUid
        );
        console.log(`Received ${uids.length} mails in the past 30 days`);
        // See https://how-to-dormspam.mit.edu/.
        const dormspamKeywords = [
            "bcc'd to all dorms",
            "bcc's to all dorms",
            "bcc'd to dorms",
            "bcc'ed dorms",
            "bcc'ed to dorms",
            "bcc to dorms",
            "bcc'd to everyone",
            "bcc dormlists",
            "bcc to dormlists",
            "for bc-talk"
        ];
        let fetchLeft = NUM_OF_EMAILS_TO_FETCH;
        const fetchPromises: Promise<void>[] = []; // for concurrency. LLM is slow.

        for await (let message of client.fetch(
            uids,
            {
                uid: true,
                envelope: true,
                source: true
            },
            { uid: true, changedSince: 0n }
        )) {
            const parsed = await simpleParser(message.source, { skipImageLinks: true });
            if (dormspamKeywords.some((keyword) => parsed.text?.includes(keyword))) {
                const sender = parsed.from?.value[0];
                const { messageId, from } = parsed;
                if (sender === undefined || sender.address === undefined) continue;
                const senderModel = await prisma.emailSender.upsert({
                    where: { email: sender.address },
                    create: {
                        email: sender.address,
                        name: sender.name || sender.address
                    },
                    update: { name: sender.name || sender.address }
                });

                // fetchPromises.push(writeItDown(message.uid, parsed));
                if (--fetchLeft == 0) {
                    // await Promise.all(fetchPromises);
                    break;
                }
            }
        }
    } finally {
        lock.release();
    }
    await client.logout();
}

/**
 * Extracts the event from the parsed email
 *
 * @param parsed the parsed email
 * @returns an event object
 */
async function processParsedEmail(parsed: ParsedMail) {
    const subject = parsed.subject ?? "No subject";
    const text = parsed.text ?? "No text";
    const dateReceived = parsed.date ?? assert.fail("No date received");
    const extractedEvent: Event = await extractFromEmail(subject, text, dateReceived);
    return extractedEvent;
}

/**
 * Writes the email and the extracted event to a file
 *
 * @param messageID the message uid. Used as the filename
 * @param parsed the parsed email
 */
async function writeItDown(messageID: number, parsed: ParsedMail) {
    const extractedEvent = await processParsedEmail(parsed);
    if (!fs.existsSync("testmails")) {
        fs.mkdirSync("testmails");
    }
    const emailPromise = fs.promises.writeFile(
        `testmails/${messageID}.eml`,
        `Subject: ${parsed.subject}\nBody:\n${parsed.text}`
    );
    const jsonPromise = fs.promises.writeFile(
        `testmails/${messageID}.json`,
        JSON.stringify(extractedEvent, null, 4)
    );
    await Promise.all([emailPromise, jsonPromise]);
}

await main();
