import express from "express";
import fs from "fs";
import { createProxyMiddleware } from "http-proxy-middleware";
import https from "https";
import dotenv from "dotenv";

dotenv.config();
const IP = process.env.REMOTE_IP ?? "localhost";

/**
 * Starts a local HTTPS relay server that proxies incoming requests to a specified target.
 *
 * Reads the SSL private key and certificate from "selfsigned.key" and "selfsigned.crt" files,
 * sets up an Express application with URL-encoded body parsing, and proxies requests to
 * `https://${IP}:4443` using `http-proxy-middleware`.
 *
 * The server listens on port 443 for inbound requests.
 *
 * @returns {Promise<void>} A promise that can be resolved or rejected externally to control the server's lifecycle.
 *
 * @throws Will throw if reading the key or certificate files fails.
 */
async function relay(): Promise<void> {
    const [privateKey, publicKey] = await Promise.all([
        fs.promises.readFile("selfsigned.key", "utf8"),
        fs.promises.readFile("selfsigned.crt", "utf8")
    ]);


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
}

await relay();
