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
import { DataSource, Prisma, PrismaClient } from "@prisma/client";
import assert, { AssertionError } from "assert";
import express from "express";
import asyncHandler from "express-async-handler";
import fs from "fs";
import HttpStatus, { REQUEST_URI_TOO_LONG } from "http-status-codes";
import https from "https";
import { ImapFlow } from "imapflow";
import { ParsedMail, simpleParser } from "mailparser";

import { CURRENT_MODEL_NAME, Event, extractFromEmail } from "./llm.js";

type AuthResult = { user: string; accessToken: string; expiresOn: number };

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

const LOOKBACK_DAYS = 7;

export default async function main() {
    const auth = await authenticate();
    const client = new ImapFlow({
        host: "outlook.office365.com",
        port: 993,
        secure: true,
        auth,
        logger: false
    });

    const prisma = new PrismaClient();
    await client.connect();

    let lock = await client.getMailboxLock("INBOX");
    try {
        assert(typeof client.mailbox !== "boolean");
        console.log(`Mailbox has ${client.mailbox.exists} messages`);
        const since = new Date();
        since.setDate(new Date().getDate() - LOOKBACK_DAYS);
        const allUids = await client.search({ since: since }, { uid: true });
        const minUid = Math.min(...allUids);
        const ignoredUids = await prisma.ignoredEmail.findMany({
            select: { uid: true },
            where: {
                scrapedBy: auth.user,
                uid: { gte: minUid }
            }
        });
        const staleUids = await prisma.email.findMany({
            select: { uid: true },
            where: {
                scrapedBy: auth.user,
                uid: { gte: minUid },
                modelName: { equals: CURRENT_MODEL_NAME }
            }
        });
        const seenUids = ignoredUids.concat(staleUids).map((email) => email.uid);
        const uids = allUids.filter((uid) => !seenUids.includes(uid));
        console.log(`Received ${uids.length} mails in the past ${LOOKBACK_DAYS} days`);
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
            await processMail(prisma, auth.user, message.uid, parsed);
        }
    } finally {
        lock.release();
        await prisma.$disconnect();
    }
    await client.logout();
}

function isDormspam(parsed: ParsedMail): boolean {
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
    return dormspamKeywords.some((keyword) => parsed.text?.includes(keyword));
}

async function processMail(
    prisma: PrismaClient,
    scrapedBy: string,
    uid: number,
    parsed: ParsedMail
): Promise<void> {
    const receivedAt = parsed.date ?? new Date();
    try {
        assert(isDormspam(parsed));
        const { messageId, from, html, subject } = parsed;
        assert(messageId !== undefined && from !== undefined && html && subject !== undefined);
        const sender = from.value[0];
        assert(sender.address !== undefined);
        const senderAddress = sender.address;
        const senderName = sender.name ?? senderAddress;

        let inReplyTo = undefined;
        if (parsed.inReplyTo !== undefined) {
            const inReplyToEmail = await prisma.email.findUnique({
                where: { messageId: parsed.inReplyTo }
            });
            assert(inReplyToEmail !== null);
            inReplyTo = {
                connect: { messageId: parsed.inReplyTo }
            };
        }
        const email = await prisma.email.upsert({
            where: { messageId },
            create: {
                messageId,
                scrapedBy,
                uid,
                sender: {
                    connectOrCreate: {
                        where: { email: senderAddress },
                        create: {
                            email: senderAddress,
                            name: senderName
                        }
                    }
                },
                subject,
                body: html,
                receivedAt,
                modelName: CURRENT_MODEL_NAME,
                inReplyTo
            },
            update: {}
        });

        const text = parsed.text ?? "No text";
        const extractedEvent = await extractFromEmail(subject, text, receivedAt);
        if (!extractedEvent.event) return;
        // LLM may return malformed datetime.
        void extractedEvent.dateTime.toISOString();

        let root = email;
        while (root.inReplyToId !== null) {
            root =
                (await prisma.email.findUnique({ where: { messageId: root.inReplyToId } })) ??
                assert.fail("Thread root not in database");
        }

        await prisma.event.upsert({
            where: { fromEmailId: root.messageId },
            create: {
                source: DataSource.DORMSPAM,
                title: extractedEvent.title,
                date: extractedEvent.dateTime,
                location: extractedEvent.location,
                organizer: extractedEvent.organizer,
                fromEmail: {
                    connect: {
                        messageId: root.messageId
                    }
                }
            },
            update: {
                title: extractedEvent.title,
                date: extractedEvent.dateTime,
                location: extractedEvent.location,
                organizer: extractedEvent.organizer,
            }
        });
        console.log(`Registered email: ${parsed.subject}: `, extractedEvent);
    } catch (error) {
        if (error instanceof AssertionError || error instanceof RangeError) {
            console.log(`Ignored email: ${parsed.subject} ${uid}`);
            await prisma.ignoredEmail.upsert({
                where: { scrapedBy_uid: { scrapedBy, uid } },
                create: {
                    scrapedBy,
                    uid,
                    receivedAt
                },
                update: {}
            });
        } else {
            throw error;
        }
    }
}

await main();
