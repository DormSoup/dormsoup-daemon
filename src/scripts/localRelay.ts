import express from "express";
import fs from "fs";
import { createProxyMiddleware } from "http-proxy-middleware";
import https from "https";
import dotenv from "dotenv";

dotenv.config();
const IP = process.env.REMOTE_IP ?? "localhost";

async function relay(): Promise<void> {
    const [privateKey, publicKey] = await Promise.all([
        fs.promises.readFile("selfsigned.key", "utf8"),
        fs.promises.readFile("selfsigned.crt", "utf8")
    ]);

    let reject: (reason: any) => void;
    let resolve: () => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.get(
        "/",
        createProxyMiddleware({
            target: `https://${IP}:4443`,
            changeOrigin: true,
            secure: false,
        })
    );
    const server = https.createServer({ key: privateKey, cert: publicKey }, app).listen(443);
    console.log("Start listening to inbound requests");
    return promise;
}

await relay();
