import express, { Request, Response } from 'express';
import {ParsedMail, simpleParser } from "mailparser";
import processNewEmail from './emailToEvents';
import { pushToSubscribers } from './subscription';
import { flushEmbeddings } from './vectordb';
const app = express();
const port = 3000;
app.use(express.json());

const startServer = () => {
    console.log(`[${new Date().toISOString()}] Start pulling and parsing emails:`);
    console.groupEnd();
    setInterval(async () => {
        await pushToSubscribers();
        await flushEmbeddings();
    }, 1000 * 60);
};

startServer();

app.post('/eat', async (req: Request, res: Response) => {
    console.log(req.body);
    let email: ParsedMail;
    try{
        email = await simpleParser(req.body.email);
    }
    catch(e){
        console.log(`Failed to parse email: ${e}`);
        res.status(400).send(`Dormsoup's simpleParser failed to parse email: ${e}`);
        return;
    }
    console.log(`Got email, subject: ${email?.subject} sending to processNewEmail.`);
    processNewEmail(email);
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});